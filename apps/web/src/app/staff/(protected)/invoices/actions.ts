'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { commitDocumentFromBytes } from '@taxtronik/storage';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { toActionError } from '@/server/auth/rbac';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { staffActionGuard, withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

export type { ActionResult };

const PositionSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().min(0).max(100000),
  unitPrice: z.coerce.number().min(-1000000).max(1000000),
  unit: z.string().max(50).default('Stück'),
});

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  number: z.string().min(1).max(50),
  subject: z.string().min(1).max(500),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  vatRate: z.coerce.number().min(0).max(99).default(19),
  notes: z.string().max(5000).optional().or(z.literal('')),
  format: z.enum(['PDF', 'XRECHNUNG', 'ZUGFERD']).default('PDF'),
  positions: z.array(PositionSchema).min(1),
});

export async function createInvoiceAction(input: {
  clientId: string;
  number: string;
  subject: string;
  issueDate: string;
  dueDate: string;
  vatRate: number;
  notes?: string;
  format: 'PDF' | 'XRECHNUNG' | 'ZUGFERD';
  positions: Array<{ description: string; quantity: number; unitPrice: number; unit: string }>;
}): Promise<ActionResult & { invoiceId?: string }> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const data = parsed.data;

  // Beträge berechnen
  const positionsWithNet = data.positions.map((p, i) => ({
    position: i + 1,
    description: p.description,
    quantity: p.quantity,
    unitPrice: p.unitPrice,
    unit: p.unit,
    netAmount: round2(p.quantity * p.unitPrice),
  }));
  const netTotal = round2(positionsWithNet.reduce((s, p) => s + p.netAmount, 0));
  const vatTotal = round2((netTotal * data.vatRate) / 100);
  const grandTotal = round2(netTotal + vatTotal);

  let invoiceId: string;
  try {
    invoiceId = await withTenantContext(ctx, async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          tenantId,
          clientId: data.clientId,
          number: data.number,
          subject: data.subject,
          issueDate: new Date(data.issueDate),
          dueDate: new Date(data.dueDate),
          status: 'DRAFT',
          format: data.format,
          netAmount: netTotal,
          vatAmount: vatTotal,
          totalAmount: grandTotal,
          vatRate: data.vatRate,
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
          number: data.number,
          clientId: data.clientId,
          totalAmount: grandTotal,
          format: data.format,
        },
      });

      return inv.id;
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('GwG-Schranke') || msg.includes('nicht aktiv')) {
      return { ok: false, error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).' };
    }
    if (msg.includes('Unique')) {
      return { ok: false, error: 'Rechnungsnummer existiert bereits.' };
    }
    return toActionError(e);
  }

  return { ok: true, invoiceId };
}

const StatusSchema = z.object({
  invoiceId: z.string().uuid(),
});

export async function markSentAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return;
  const { tenantId, staffId, ctx } = g;
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) return;

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

  // Option B: ZUGFeRD-Archiv schon beim Ausstellen festschreiben → byte-stabile
  // GoBD-Kopie ab Ausstellung, keine CPU-Wiederholung bei späteren Downloads.
  // Best-effort: schlägt es fehl (Adresse unvollständig, Storage-Hiccup, oder
  // EXTERNAL/PDF-Rechnung), blockiert das den Versand NICHT — der Download
  // generiert dann nach. Der Status ist bereits gesetzt + auditiert.
  try {
    await ensureZugferdArchive(ctx, parsed.data.invoiceId);
  } catch {
    /* bewusst geschluckt — Archiv ist optional zum Versandzeitpunkt */
  }

  emitN8nEvent('invoice.due', { tenantId, invoiceId: parsed.data.invoiceId });
  revalidatePath('/staff/invoices');
  revalidatePath(`/staff/invoices/${parsed.data.invoiceId}`);
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const parsed = StatusSchema.safeParse({ invoiceId: formData.get('invoiceId') });
  if (!parsed.success) return;

  await withStaff(
    async (tx, { tenantId, staffId }) => {
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
  const positions: Array<{ description: string; quantity: number; unitPrice: number; unit: string }> = [];
  for (let i = 0; i < 50; i++) {
    const desc = formData.get(`positions[${i}].description`);
    if (!desc) continue;
    positions.push({
      description: String(desc),
      quantity: Number(formData.get(`positions[${i}].quantity`) ?? 0),
      unitPrice: Number(formData.get(`positions[${i}].unitPrice`) ?? 0),
      unit: String(formData.get(`positions[${i}].unit`) ?? 'Stück'),
    });
  }

  const r = await createInvoiceAction({
    clientId: String(formData.get('clientId') ?? ''),
    number: String(formData.get('number') ?? ''),
    subject: String(formData.get('subject') ?? ''),
    issueDate: String(formData.get('issueDate') ?? ''),
    dueDate: String(formData.get('dueDate') ?? ''),
    vatRate: Number(formData.get('vatRate') ?? 19),
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

      const doc = await tx.document.create({
        data: {
          tenantId,
          clientId: data.clientId,
          title: `Rechnung ${data.number}: ${data.subject}`,
          classification: 'GOBD_INVOICE',
          // P-3: Magic-Bytes statt Client-Header — siehe M-2.
          mimeType: stored.detectedMime ?? data.pdf.mimeType ?? 'application/pdf',
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: stored.targetBucket,
          storageKey: stored.targetKey,
          sha256: prismaBytes(stored.sha256),
          sizeBytes: stored.sizeBytes,
          immutable: stored.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
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
          vatRate: 0,
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
