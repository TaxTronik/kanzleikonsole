'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { commitDocumentFromBytes } from '@taxtronik/storage';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { toActionError } from '@/server/auth/rbac';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { computeVatTotals } from '@/server/invoicing/vat';
import { allocateInvoiceNumber, isValidInvoiceTransition } from '@/server/invoicing/number';
import { readModules, type InvoiceMode } from '@/server/settings/modules';
import { round2, fmtEUR, fmtDateShort } from '@/lib/fmt';
import { withTimeout, TimeoutError } from '@/lib/with-timeout';
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
// Das Rechnungsdatum bestimmt den Jahres-Nummernkreis (allocateInvoiceNumber
// liest issueDate.getUTCFullYear()). Ein frei rück-/vordatiertes Datum würde
// sonst einen fremden Jahreskreis öffnen — daher auf das laufende Jahr ± 1
// begrenzt (deckt die Jahreswechsel-Grenze ab, blockt 2020/2099).
function issueYearPlausible(dateStr: string): boolean {
  const year = new Date(dateStr).getUTCFullYear();
  const now = new Date().getUTCFullYear();
  return year >= now - 1 && year <= now + 1;
}

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  issueDate: z.string().date().refine(issueYearPlausible, {
    message: 'Rechnungsdatum liegt außerhalb des plausiblen Bereichs (laufendes Jahr ± 1).',
  }),
  dueDate: z.string().date(),
  notes: z.string().max(5000).optional().or(z.literal('')),
  format: z.enum(['PDF', 'XRECHNUNG', 'ZUGFERD']).default('PDF'),
  // max(): die Action ist direkt aufrufbar — ohne Obergrenze könnte ein
  // Aufruf beliebig viele Positionen in einer Tx anlegen.
  positions: z.array(PositionSchema).min(1).max(200),
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
  // iter87: Anlegen braucht das Einzelrecht (ADMIN/PARTNER implizit).
  const g = await staffActionGuard({ requirePermission: 'INVOICE_MANAGE' });
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

export async function markSentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // iter87: Versenden = GoB-Festschreibung — eigenes Einzelrecht INVOICE_SEND.
  const g = await staffActionGuard({ requirePermission: 'INVOICE_SEND' });
  if (!g.ok) {
    // Befund 9: Guard-Ablehnung strukturiert loggen UND an die UI zurückmelden
    // (früher Form-Action ohne Result-Channel → kommentarlos verschluckt).
    log.warn({ component: 'invoices', action: 'markSent', err: g.error }, 'markSentAction: Guard abgelehnt');
    return { ok: false, error: g.error };
  }
  const { tenantId, staffId, ctx } = g;
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) {
    log.warn({ component: 'invoices', action: 'markSent' }, 'markSentAction: ungültige invoiceId');
    return { ok: false, error: 'Ungültige Rechnungs-ID.' };
  }

  // iter85 (GoB): Precondition + Archiv-PFLICHT vor dem Versand.
  // Nur DRAFT → SENT; und die byte-stabile GoBD-Archivkopie muss VOR der
  // Festschreibung existieren — vorher war das Archiv best-effort und eine
  // SENT-Rechnung konnte ohne revisionssichere Kopie existieren (Befund 8).
  // PDF-/EXTERNAL-Formate haben kein Generat (not_applicable) und passieren.
  const current = await withTenantContext(ctx, (tx) =>
    tx.invoice.findUnique({ where: { id: parsed.data.invoiceId }, select: { status: true } }),
  );
  if (!current) return { ok: false, error: 'Rechnung nicht gefunden.' };
  if (!isValidInvoiceTransition(current.status, 'SENT')) {
    return { ok: false, error: `Statuswechsel ${current.status} → SENT ist nicht zulässig.` };
  }

  let archive;
  try {
    archive = await withTimeout(ensureZugferdArchive(ctx, parsed.data.invoiceId), 45_000);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof TimeoutError
          ? 'ZUGFeRD-Archiv konnte nicht rechtzeitig erzeugt werden — bitte erneut versuchen.'
          : `ZUGFeRD-Archiv konnte nicht erzeugt werden: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!archive.ok && archive.code !== 'not_applicable') {
    return {
      ok: false,
      error: `Versand abgebrochen — GoBD-Archivkopie konnte nicht erstellt werden: ${ARCHIVE_FAIL_TEXT[archive.code] ?? archive.code}`,
    };
  }

  const sent = await withTenantContext(ctx, async (tx) => {
    // TOCTOU-Schutz: Der Statuswechsel ist NUR gültig, solange die Rechnung
    // noch DRAFT ist. Bei Doppel-Submit (zwei Tabs / zwei Bearbeiter) passieren
    // beide den Precheck oben, aber nur der erste trifft hier status=DRAFT —
    // der zweite läuft ins Leere (count 0) statt sentAt zu überschreiben und
    // ein zweites invoice.send/invoice.due-Event zu erzeugen.
    const res = await tx.invoice.updateMany({
      where: { id: parsed.data.invoiceId, status: 'DRAFT' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    if (res.count === 0) return null;

    const updated = await tx.invoice.findUniqueOrThrow({ where: { id: parsed.data.invoiceId } });
    // Portal-Freigabe der Archivkopie ist Teil des Versands (der Archiv-Helfer
    // lief noch im Status DRAFT und hat bewusst nicht freigegeben).
    if (updated.documentId) {
      await tx.document.updateMany({
        where: { id: updated.documentId, sharedWithClientAt: null },
        data: { sharedWithClientAt: new Date(), sharedByStaff: staffId },
      });
    }
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'invoice.send',
      resourceType: 'invoice',
      resourceId: updated.id,
      after: { number: updated.number, sentAt: updated.sentAt },
    });
    return updated;
  });

  // Race verloren → kein doppeltes n8n-Event, kein doppeltes Revalidate. Der
  // gewünschte Endzustand (SENT) ist durch das konkurrierende Request erreicht.
  if (!sent) return { ok: true };

  // Mandant über den Versand informieren. Template-Slug 'invoice-sent' — falls
  // im ACP keines definiert ist, greift der Fallback (hartcodiert). Fire-and-
  // forget: ein Mail-Versand-Fehler scheitert nicht den Rechnungs-Versand.
  const client = await withTenantContext(ctx, (tx) =>
    tx.client.findUnique({
      where: { id: sent.clientId },
      select: { name: true, invoiceEmail: true },
    }),
  );
  if (client?.invoiceEmail) {
    fireAndForget('sendTemplateMail (invoice-sent)', sendTemplateMail({
      tenantId,
      slug: 'invoice-sent',
      to: client.invoiceEmail,
      vars: {
        client: { name: client.name },
        invoice: {
          number: sent.number,
          total: fmtEUR(Number(sent.totalAmount.toString())),
          dueDate: sent.dueDate ? fmtDateShort(sent.dueDate) : '—',
        },
        link: `${portalBaseUrl}/portal/invoices`,
      },
      fallback: {
        subject: 'Neue Rechnung — {{client.name}}',
        bodyMd:
          'Sehr geehrte/r {{client.name}},\n\n' +
          'eine neue Rechnung ({{invoice.number}}) über {{invoice.total}} steht in Ihrem Mandantenportal bereit.\n' +
          'Fälligkeit: {{invoice.dueDate}}\n\n' +
          'Zur Übersicht: {{link}}',
      },
    }));
  }

  emitN8nEvent('invoice.due', { tenantId, invoiceId: parsed.data.invoiceId });
  revalidatePath('/staff/invoices');
  revalidatePath(`/staff/invoices/${parsed.data.invoiceId}`);
  return { ok: true };
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) return;

  const r = await withStaff(
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
    { requirePermission: 'INVOICE_MANAGE', revalidate: ['/staff/invoices', `/staff/invoices/${parsed.data.invoiceId}`] },
  );
  // Ablehnung (z. B. unzulässiger Statuswechsel bei veralteter Seite) darf nicht
  // still verpuffen — werfen, damit die UI den Grund zeigt statt eines No-ops.
  if (!r.ok) throw new ActionError(r.error ?? 'Aktion fehlgeschlagen.');
}

export async function cancelInvoiceAction(formData: FormData): Promise<void> {
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) return;

  const r = await withStaff(
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
      // Storno gibt die abgerechneten Zeiteinträge zur Neuabrechnung frei:
      // ihr invoiceId-Link ist nur der Abrechnungs-Pool-Marker, NICHT Teil der
      // festgeschriebenen Rechnungspositionen (die als eigene InvoicePosition-
      // Snapshots an der stornierten Rechnung erhalten bleiben). Ohne das wären
      // die Stunden dauerhaft gefesselt — weder neu abrechenbar (Pool-Filter
      // invoiceId:null) noch löschbar (Löschschutz für abgerechnete Einträge).
      const released = await tx.timeEntry.updateMany({
        where: { invoiceId: parsed.data.invoiceId },
        data: { invoiceId: null },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.cancel',
        resourceType: 'invoice',
        resourceId: updated.id,
        after: { number: updated.number, releasedTimeEntries: released.count },
      });
    },
    { requirePermission: 'INVOICE_MANAGE', revalidate: ['/staff/invoices', `/staff/invoices/${parsed.data.invoiceId}`] },
  );
  if (!r.ok) throw new ActionError(r.error ?? 'Aktion fehlgeschlagen.');
}

// ----------------------------------------------------------------------------
// EXTERNAL-Modus: PDF-Rechnung hochladen, in Object-Lock ablegen, Mandant
// per Mail mit Anhang informieren. Keine Positionen, keine XRechnung — die
// Rechnung kommt fertig aus der zentralen Rechnungssoftware.
// ----------------------------------------------------------------------------

// Das Format `YYYY-NNNN` ist dem automatischen Nummernkreis vorbehalten —
// `allocateInvoiceNumber` initialisiert die Sequenz aus dem MAX dieser Nummern.
// Eine EXTERNAL-Fremdnummer in genau diesem Muster könnte einen Sequenz-Slot
// belegen und die nächste Auto-Vergabe in eine endlose Unique-Kollision treiben.
const RESERVED_AUTO_NUMBER = /^\d{4}-\d+$/;

const UploadExternalSchema = z.object({
  clientId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  number: z.string().min(1).max(50).refine((n) => !RESERVED_AUTO_NUMBER.test(n), {
    message: 'Diese Nummer hat das Format des automatischen Nummernkreises (JJJJ-NNNN) und ist reserviert. Bitte die Originalnummer des Fremdsystems verwenden.',
  }),
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
  // iter87: EXTERNAL-Upload stellt aus UND stellt zu (Mail an Mandanten) —
  // das ist der Versand-Akt, daher INVOICE_SEND statt INVOICE_MANAGE.
  const g = await staffActionGuard({ requirePermission: 'INVOICE_SEND' });
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
