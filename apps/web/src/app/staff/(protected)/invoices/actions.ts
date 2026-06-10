'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { commitDocumentFromBytes } from '@taxtronik/storage';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { toActionError } from '@/server/auth/rbac';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { computeVatTotals } from '@/server/invoicing/vat';
import { allocateInvoiceNumber, isValidInvoiceTransition } from '@/server/invoicing/number';
import { readModules, type InvoiceMode } from '@/server/settings/modules';
import { log } from '@/server/logger';
import { staffActionGuard, withStaff, ActionError, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';
import type { TenantContext } from '@taxtronik/db';

export type ActionResult = BaseActionResult;

// Defense in Depth (Befund 11 der Modul-Inventur): das invoiceMode-Gate lag
// nur in der UI (new/page.tsx) — die Actions selbst waren bei deaktiviertem
// bzw. falschem Modus direkt aufrufbar.
async function requireInvoiceMode(ctx: TenantContext, mode: InvoiceMode): Promise<ActionResult | null> {
  const modules = await readModules(ctx);
  if (modules.invoiceMode !== mode) {
    return { ok: false, error: 'Das Rechnungsmodul ist für diesen Vorgang nicht aktiviert.' };
  }
  return null;
}

const PositionSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().min(0).max(100000),
  unitPrice: z.coerce.number().min(-1000000).max(1000000),
  unit: z.string().max(50).default('Stück'),
  // iter86 (§ 14 Abs. 4 Nr. 8 UStG): Steuersatz je Position.
  vatRate: z.coerce.number().min(0).max(99).default(19),
});

// iter85 (GoB): KEIN number-Feld mehr — die Rechnungsnummer wird automatisch
// und lückenlos aus dem Nummernkreis vergeben (allocateInvoiceNumber, in
// derselben Tx wie der INSERT). Manuelle Nummern gibt es nur noch im
// EXTERNAL-Modus (Nummer des Fremdsystems).
const CreateSchema = z.object({
  clientId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  notes: z.string().max(5000).optional().or(z.literal('')),
  format: z.enum(['PDF', 'XRECHNUNG', 'ZUGFERD']).default('PDF'),
  positions: z.array(PositionSchema).min(1),
});

export async function createInvoiceAction(input: {
  clientId: string;
  subject: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  format: 'PDF' | 'XRECHNUNG' | 'ZUGFERD';
  positions: Array<{ description: string; quantity: number; unitPrice: number; unit: string; vatRate: number }>;
}): Promise<ActionResult & { invoiceId?: string; number?: string }> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const gate = await requireInvoiceMode(ctx, 'IN_APP');
  if (gate) return gate;

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const data = parsed.data;

  // Beträge berechnen — USt je Satz-Gruppe (§ 14 Abs. 4 Nr. 8 UStG, iter86).
  const positionsWithNet = data.positions.map((p, i) => ({
    position: i + 1,
    description: p.description,
    quantity: p.quantity,
    unitPrice: p.unitPrice,
    unit: p.unit,
    netAmount: round2(p.quantity * p.unitPrice),
    vatRate: p.vatRate,
  }));
  const totals = computeVatTotals(positionsWithNet);

  let invoiceId: string;
  let invoiceNumber: string;
  try {
    [invoiceId, invoiceNumber] = await withTenantContext(ctx, async (tx) => {
      // Lückenlose Vergabe in DERSELBEN Tx: scheitert der INSERT, rollt die
      // Sequenz mit zurück — es entsteht keine Lücke.
      const number = await allocateInvoiceNumber(tx, tenantId, new Date(data.issueDate));
      const inv = await tx.invoice.create({
        data: {
          tenantId,
          clientId: data.clientId,
          number,
          subject: data.subject,
          issueDate: new Date(data.issueDate),
          dueDate: new Date(data.dueDate),
          status: 'DRAFT',
          format: data.format,
          netAmount: totals.netAmount,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
          // Kopf-Satz nur bei einheitlichem Satz (Anzeige/CSV); Mischsätze → null.
          vatRate: totals.uniformRate,
          notes: data.notes || null,
          createdByStaff: staffId,
          positions: { create: positionsWithNet },
        },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.create',
        resourceType: 'invoice',
        resourceId: inv.id,
        after: {
          number,
          clientId: data.clientId,
          totalAmount: totals.totalAmount,
          format: data.format,
        },
      });

      return [inv.id, number] as const;
    });
  } catch (e) {
    // Befund 8: Klassifikation über Prisma-Error-Code statt fragiler Message-
    // Substrings (msg.includes('Unique') / includes('nicht aktiv') matchte
    // z. B. auch „nicht aktiviert"). P2002 = Unique-Violation, symmetrisch zu
    // uploadExternalInvoiceAction unten.
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Rechnungsnummer existiert bereits.' };
    }
    // GwG-Schranke: DB-Trigger (RAISE EXCEPTION … 'GwG-Schranke', SQLSTATE
    // P0001) — Prisma kennt den Code nicht und reicht den Trigger-Text in der
    // Message durch. Der Marker „GwG-Schranke" ist der stabile Vertrag aus den
    // Migrationen (init/iter2/iter5).
    if ((e as Error).message?.includes('GwG-Schranke')) {
      return { ok: false, error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).' };
    }
    return toActionError(e);
  }

  return { ok: true, invoiceId, number: invoiceNumber };
}

const StatusSchema = z.object({
  invoiceId: z.string().uuid(),
});

const ARCHIVE_FAIL_TEXT: Record<string, string> = {
  not_found: 'Rechnung nicht gefunden.',
  seller_incomplete: 'Kanzlei-Rechnungsabsender unvollständig — Name, Anschrift, E-Mail und Telefon sind Pflicht (Einstellungen → Rechnungsdaten).',
  buyer_incomplete: 'Mandanten-Anschrift unvollständig (Straße/PLZ/Ort).',
};

export async function markSentAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) {
    // Befund 9: Form-Action ohne Result-Channel — Guard-Ablehnung mindestens
    // strukturiert loggen statt kommentarlos zu verschlucken.
    log.warn({ component: 'invoices', action: 'markSent', err: g.error }, 'markSentAction: Guard abgelehnt');
    return;
  }
  const { tenantId, staffId, ctx } = g;
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) {
    log.warn({ component: 'invoices', action: 'markSent' }, 'markSentAction: ungültige invoiceId');
    return;
  }

  // iter85 (GoB): Precondition + Archiv-PFLICHT vor dem Versand.
  // Nur DRAFT → SENT; und die byte-stabile GoBD-Archivkopie muss VOR der
  // Festschreibung existieren — vorher war das Archiv best-effort und eine
  // SENT-Rechnung konnte ohne revisionssichere Kopie existieren (Befund 8).
  // PDF-/EXTERNAL-Formate haben kein Generat (not_applicable) und passieren.
  const current = await withTenantContext(ctx, (tx) =>
    tx.invoice.findUnique({ where: { id: parsed.data.invoiceId }, select: { status: true } }),
  );
  if (!current) return;
  if (!isValidInvoiceTransition(current.status, 'SENT')) {
    throw new ActionError(`Statuswechsel ${current.status} → SENT ist nicht zulässig.`);
  }

  const archive = await ensureZugferdArchive(ctx, parsed.data.invoiceId);
  if (!archive.ok && archive.code !== 'not_applicable') {
    throw new ActionError(
      `Versand abgebrochen — GoBD-Archivkopie konnte nicht erstellt werden: ${ARCHIVE_FAIL_TEXT[archive.code] ?? archive.code}`,
    );
  }

  await withTenantContext(ctx, async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: parsed.data.invoiceId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'invoice.send',
      resourceType: 'invoice',
      resourceId: updated.id,
      after: { number: updated.number, sentAt: updated.sentAt },
    });
  });

  emitN8nEvent('invoice.due', { tenantId, invoiceId: parsed.data.invoiceId });
  revalidatePath('/staff/invoices');
  revalidatePath(`/staff/invoices/${parsed.data.invoiceId}`);
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) return;

  await withStaff(
    async (tx, { tenantId, staffId }) => {
      // iter85: Precondition (UI verbirgt den Button, die Action prüft selbst;
      // der DB-Trigger ist der Backstop).
      const current = await tx.invoice.findUnique({
        where: { id: parsed.data.invoiceId }, select: { status: true },
      });
      if (!current) return;
      if (!isValidInvoiceTransition(current.status, 'PAID')) {
        throw new ActionError(`Statuswechsel ${current.status} → PAID ist nicht zulässig.`);
      }
      const updated = await tx.invoice.update({
        where: { id: parsed.data.invoiceId },
        data: { status: 'PAID', paidAt: new Date() },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.paid',
        resourceType: 'invoice',
        resourceId: updated.id,
        after: { number: updated.number, paidAt: updated.paidAt },
      });
    },
    { revalidate: ['/staff/invoices', `/staff/invoices/${parsed.data.invoiceId}`] },
  );
}

export async function cancelInvoiceAction(formData: FormData): Promise<void> {
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) return;

  await withStaff(
    async (tx, { tenantId, staffId }) => {
      // iter85: PAID/CANCELLED sind terminal — vorher war z. B. PAID → CANCELLED
      // per direktem Action-Aufruf möglich (Schutz lag nur in der UI).
      const current = await tx.invoice.findUnique({
        where: { id: parsed.data.invoiceId }, select: { status: true },
      });
      if (!current) return;
      if (!isValidInvoiceTransition(current.status, 'CANCELLED')) {
        throw new ActionError(`Statuswechsel ${current.status} → CANCELLED ist nicht zulässig.`);
      }
      const updated = await tx.invoice.update({
        where: { id: parsed.data.invoiceId },
        data: { status: 'CANCELLED' },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.cancel',
        resourceType: 'invoice',
        resourceId: updated.id,
        after: { number: updated.number },
      });
    },
    { revalidate: ['/staff/invoices', `/staff/invoices/${parsed.data.invoiceId}`] },
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Formular-Helper für create-Page (transformiert FormData inkl. Position-Repeater).
// Delegiert an createInvoiceAction (dort sitzt das Auth-Gate).
export async function createInvoiceFromFormAction(formData: FormData): Promise<void> {
  const positions: Array<{ description: string; quantity: number; unitPrice: number; unit: string; vatRate: number }> = [];
  for (let i = 0; i < 50; i++) {
    const desc = formData.get(`positions[${i}].description`);
    if (!desc) continue;
    positions.push({
      description: String(desc),
      quantity: Number(formData.get(`positions[${i}].quantity`) ?? 0),
      unitPrice: Number(formData.get(`positions[${i}].unitPrice`) ?? 0),
      unit: String(formData.get(`positions[${i}].unit`) ?? 'Stück'),
      vatRate: Number(formData.get(`positions[${i}].vatRate`) ?? 19),
    });
  }

  const r = await createInvoiceAction({
    clientId: String(formData.get('clientId') ?? ''),
    subject: String(formData.get('subject') ?? ''),
    issueDate: String(formData.get('issueDate') ?? ''),
    dueDate: String(formData.get('dueDate') ?? ''),
    notes: String(formData.get('notes') ?? ''),
    format: (String(formData.get('format') ?? 'PDF') as 'PDF' | 'XRECHNUNG' | 'ZUGFERD'),
    positions,
  });

  if (!r.ok || !r.invoiceId) {
    // Fehler werden nicht gefangen — Browser zeigt Server-Action-Fehler;
    // bessere UX kommt im Client-Component-Wrapper.
    throw new ActionError(r.error ?? 'Rechnungsanlage fehlgeschlagen.');
  }

  revalidatePath('/staff/invoices');
  redirect(`/staff/invoices/${r.invoiceId}`); // wirft (never) — NACH der delegierten Action
}

// ----------------------------------------------------------------------------
// EXTERNAL-Modus: PDF-Rechnung hochladen, in Object-Lock ablegen, Mandant
// per Mail mit Anhang informieren. Keine Positionen, keine XRechnung — die
// Rechnung kommt fertig aus der zentralen Rechnungssoftware.
// ----------------------------------------------------------------------------

const UploadExternalSchema = z.object({
  clientId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  number: z.string().min(1).max(50),
  subject: z.string().min(1).max(200),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  totalAmount: z.coerce.number().min(0).max(100_000_000),
  notes: z.string().max(1000).nullable().optional(),
  pdf: z.object({
    fileName: z.string().max(255),
    mimeType: z.string().max(100),
    base64: z.string().min(1),
  }),
});

export async function uploadExternalInvoiceAction(input: z.infer<typeof UploadExternalSchema>): Promise<{
  ok: boolean;
  error?: string;
  id?: string;
}> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const gate = await requireInvoiceMode(ctx, 'EXTERNAL');
  if (gate) return gate;

  const parsed = UploadExternalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  const data = parsed.data;

  const pdfBytes = Buffer.from(data.pdf.base64, 'base64');
  if (pdfBytes.length === 0) return { ok: false, error: 'PDF-Daten leer.' };
  if (pdfBytes.length > 10 * 1024 * 1024) return { ok: false, error: 'PDF zu groß (max. 10 MB).' };

  // 1) PDF in Object-Lock (GoBD-Aufbewahrung 10 J.) ablegen
  let stored: Awaited<ReturnType<typeof commitDocumentFromBytes>>;
  try {
    stored = await commitDocumentFromBytes({
      fileData: pdfBytes,
      classification: 'GOBD_INVOICE',
      tenantId,
    });
  } catch (e) {
    return { ok: false, error: `Storage-Fehler: ${(e as Error).message}` };
  }

  // 2) Document + Invoice + Audit in einer Transaktion
  let invoiceId: string;
  let recipients: { email: string; fullName: string }[] = [];
  let mailTemplateSlug: string | null = null;
  let clientName = '';
  try {
    invoiceId = await withTenantContext(ctx, async (tx) => {
      const cat = data.categoryId
        ? await tx.invoiceCategory.findUnique({
            where: { id: data.categoryId },
            select: { id: true, emailTemplateSlug: true, name: true },
          })
        : null;
      mailTemplateSlug = cat?.emailTemplateSlug ?? null;

      const cli = await tx.client.findUnique({
        where: { id: data.clientId },
        select: { name: true, contacts: { where: { active: true, notificationsEnabled: true }, select: { email: true, fullName: true } } },
      });
      if (!cli) throw new ActionError('Mandant nicht gefunden.');
      clientName = cli.name;
      recipients = cli.contacts;

      // Befund 12: Document+Version-Insert zentral (upload-helpers).
      const { document: doc } = await createDocumentWithVersion(tx, {
        documentData: {
          tenantId,
          clientId: data.clientId,
          title: `Rechnung ${data.number}: ${data.subject}`,
          classification: 'GOBD_INVOICE',
          // P-3: Magic-Bytes statt Client-Header — siehe M-2.
          mimeType: stored.detectedMime ?? data.pdf.mimeType ?? 'application/pdf',
          // iter85 (Befund 7): Rechnungs-PDFs sind FÜR den Mandanten bestimmt —
          // ohne Freigabe lief der „Öffnen"-Link im Portal auf 404 (die
          // Portal-Download-Route filtert auf sharedWithClientAt).
          sharedWithClientAt: new Date(),
          sharedByStaff: staffId,
        },
        commit: stored,
        createdById: staffId,
      });

      const inv = await tx.invoice.create({
        data: {
          tenantId,
          clientId: data.clientId,
          categoryId: data.categoryId ?? null,
          number: data.number,
          subject: data.subject,
          issueDate: new Date(data.issueDate),
          dueDate: new Date(data.dueDate),
          status: 'SENT',
          format: 'PDF',
          netAmount: data.totalAmount,  // EXTERNAL: kein USt-Split, Brutto=Netto pro Pos
          vatAmount: 0,
          totalAmount: data.totalAmount,
          // iter86: kein bekannter Satz (Ausweis steht in der Fremd-PDF) → NULL
          // statt fälschlich 0 % (CSV wies vorher USt 0 aus).
          vatRate: null,
          notes: data.notes ?? null,
          documentId: doc.id,
          createdByStaff: staffId,
          sentAt: new Date(),
        },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.upload',
        resourceType: 'invoice',
        resourceId: inv.id,
        after: {
          clientId: data.clientId,
          number: data.number,
          totalAmount: data.totalAmount,
          categoryId: data.categoryId ?? null,
          documentId: doc.id,
        },
      });

      return inv.id;
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Rechnungsnummer bereits vergeben.' };
    }
    return toActionError(e);
  }

  // 3) Mail mit PDF-Anhang an aktive Kontakte mit Opt-in
  for (const r of recipients) {
    await sendTemplateMail({
      tenantId,
      slug: mailTemplateSlug ?? 'invoice-sent',
      to: r.email,
      vars: {
        contact: { fullName: r.fullName, email: r.email },
        client: { name: clientName },
        invoice: {
          number: input.number,
          subject: input.subject,
          totalAmount: input.totalAmount,
          dueDate: input.dueDate,
        },
      },
      n8nEvent: 'invoice.due',
      n8nPayload: { tenantId, invoiceId },
      fallback: {
        subject: 'Ihre Rechnung {{invoice.number}}',
        bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nanbei senden wir Ihnen unsere Rechnung Nr. {{invoice.number}} über {{invoice.totalAmount}} €.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
      },
      attachments: [
        {
          filename: `Rechnung-${input.number}.pdf`,
          content: pdfBytes,
          contentType: 'application/pdf',
        },
      ],
    }).catch(() => void 0);
  }

  revalidatePath('/staff/invoices');
  revalidatePath(`/portal/invoices`);
  return { ok: true, id: invoiceId };
}
