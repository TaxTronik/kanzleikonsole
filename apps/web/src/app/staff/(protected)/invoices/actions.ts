'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { enqueueDirectMailTx, kickMailOutboxDelivery } from '@/server/mail/outbox';
import { readUploadFile } from '@/server/documents/upload-file';
import {
  JournaledUploadError,
  runJournaledUpload,
  uploadFailureCause,
} from '@/server/documents/journaled-upload';
import { portalBaseUrl } from '@taxtronik/config';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { archiveFailureMessage } from '@/server/invoicing/archive-failure';
import { IN_APP_VAT_RATES } from '@/server/invoicing/vat';
import {
  checkDraftInvoice,
  createDraftInvoiceTx,
  type DraftInvoiceHeader,
} from '@/server/invoicing/create-draft';
import { allocateInvoiceNumber, isValidInvoiceTransition } from '@/server/invoicing/number';
import { toStornoPosition } from '@/server/invoicing/storno';
import { claimInvoiceDraftForSend } from '@/server/invoicing/send-claim';
import { claimInvoicePayment } from '@/server/invoicing/payment-claim';
import { discardNeverSentDraftArchiveTx } from '@/server/invoicing/draft-archive';
import { lockInvoiceArchiveTx } from '@/server/invoicing/archive-lock';
import { readModules, type InvoiceMode } from '@/server/settings/modules';
import { round2, fmtEUR, fmtDateShort, berlinTodayUtcMidnight } from '@/lib/fmt';
import { withTimeout, TimeoutError } from '@/lib/with-timeout';
import { log } from '@/server/logger';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  parseFormData,
  type ActionResult as BaseActionResult,
  type StaffCtx,
} from '@/server/actions/staff-action';
import type { TenantContext } from '@taxtronik/db';

export type ActionResult = BaseActionResult;

// Defense in Depth (Befund 11 der Modul-Inventur): das invoiceMode-Gate lag
// nur in der UI (new/page.tsx) — die Actions selbst waren bei deaktiviertem
// bzw. falschem Modus direkt aufrufbar.
async function requireInvoiceMode(
  ctx: TenantContext,
  mode: InvoiceMode,
): Promise<ActionResult | null> {
  const modules = await readModules(ctx);
  if (modules.invoiceMode !== mode) {
    return { ok: false, error: 'Das Rechnungsmodul ist für diesen Vorgang nicht aktiviert.' };
  }
  return null;
}

const PositionSchema = z
  .object({
    description: z.string().min(1).max(500),
    quantity: z.coerce
      .number()
      .min(0)
      .max(100000)
      .refine((n) => round2(n) === n, {
        message: 'Menge darf höchstens zwei Nachkommastellen haben.',
      }),
    // EN 16931 BR-27: BT-146 (Artikel-Nettopreis) darf nicht negativ sein.
    // Gutschriften/Stornos werden über eine negative Menge modelliert.
    unitPrice: z.coerce
      .number()
      .min(0)
      .max(1000000)
      .refine((n) => round2(n) === n, {
        message: 'Einzelpreis darf höchstens zwei Nachkommastellen haben.',
      }),
    unit: z.string().max(50).default('Stück'),
    // iter86 (§ 14 Abs. 4 Nr. 8 UStG): Steuersatz je Position; serverseitige
    // Whitelist (IN_APP_VAT_RATES) statt freiem 0–99-Bereich.
    vatRate: z.coerce
      .number()
      .refine((r) => (IN_APP_VAT_RATES as readonly number[]).includes(r), {
        message: 'Ungültiger USt-Satz (zulässig: 0 %, 7 %, 19 %).',
      })
      .default(19),
  })
  // Positionsbetrag muss in Decimal(12,2) passen (max. 9.999.999.999,99) —
  // sonst DB-Fehler statt Validierungsmeldung.
  .refine((p) => Math.abs(p.quantity * p.unitPrice) <= 9_999_999_999.99, {
    message: 'Positionsbetrag zu groß (max. 9.999.999.999,99 €).',
  });

// iter85 (GoB): KEIN number-Feld mehr — die Rechnungsnummer wird automatisch
// und lückenlos aus dem Nummernkreis vergeben (createDraftInvoiceTx, in
// derselben Tx wie der INSERT). Manuelle Nummern gibt es nur noch im
// EXTERNAL-Modus (Nummer des Fremdsystems). Rechnungsjahr (laufendes Jahr
// ± 1), Leistungszeitraum, Steuer- und Betragsgrenzen prüft der gemeinsame
// Anlageservice für alle In-App-Pfade.
const CreateSchema = z.object({
  clientId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  notes: z.string().max(5000).optional().or(z.literal('')),
  // iter98: optionaler Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG). Nur wirksam,
  // wenn BEIDE gesetzt sind; sonst gilt das Rechnungsdatum.
  servicePeriodStart: z.string().date().optional().or(z.literal('')),
  servicePeriodEnd: z.string().date().optional().or(z.literal('')),
  // iter101: Befreiungsgrund für 0 %-Umsätze (§ 14 Abs. 4 Nr. 8 UStG).
  vatExemptionReason: z.string().max(500).optional().or(z.literal('')),
  // iter107: Reverse-Charge (§ 13b UStG). Alle Positionen 0 %, Mandant braucht USt-IdNr.
  reverseCharge: z.boolean().optional().default(false),
  // H-4: IN_APP-Rechnungen brauchen ein Generat mit GoBD-Archivkopie. Das
  // reine „PDF" (kein Generat, kein Dokument) ist nur der EXTERNAL-Upload-Weg.
  format: z.enum(['XRECHNUNG', 'ZUGFERD']).default('ZUGFERD'),
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
  servicePeriodStart?: string;
  servicePeriodEnd?: string;
  vatExemptionReason?: string;
  reverseCharge?: boolean;
  format: 'XRECHNUNG' | 'ZUGFERD';
  positions: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    unit: string;
    vatRate: number;
  }>;
}): Promise<ActionResult & { invoiceId?: string; number?: string }> {
  // iter87: Anlegen braucht das Einzelrecht (ADMIN/PARTNER implizit).
  const g = await staffActionGuard({
    requirePermission: 'INVOICE_MANAGE',
    modeModule: 'invoices',
  });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const gate = await requireInvoiceMode(ctx, 'IN_APP');
  if (gate) return gate;

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const data = parsed.data;
  const header: DraftInvoiceHeader = {
    clientId: data.clientId,
    subject: data.subject,
    issueDate: new Date(data.issueDate),
    dueDate: new Date(data.dueDate),
    servicePeriodStart: data.servicePeriodStart ? new Date(data.servicePeriodStart) : null,
    servicePeriodEnd: data.servicePeriodEnd ? new Date(data.servicePeriodEnd) : null,
    vatExemptionReason: data.vatExemptionReason || null,
    reverseCharge: data.reverseCharge,
    format: data.format,
    notes: data.notes || null,
  };

  // Reine Prüfungen schon vor der Transaktion (der Service wiederholt sie).
  const checked = checkDraftInvoice(header, data.positions);
  if (!checked.ok) return { ok: false, error: checked.error };

  try {
    const invoice = await withTenantContext(ctx, async (tx) => {
      // Vertraulich-/RESTRICTED-Ventil (Gegenstück in clients/[id]/billing).
      await assertClientAccessTx(tx, g.session, data.clientId);
      return createDraftInvoiceTx(tx, { tenantId, staffId }, header, data.positions, {
        kind: 'manual',
      });
    });
    return { ok: true, invoiceId: invoice.id, number: invoice.number };
  } catch (e) {
    // Nummernkonflikt und GwG-Schranke bildet createDraftInvoiceTx ab.
    return toActionError(e);
  }
}

const StatusSchema = z.object({
  invoiceId: z.string().uuid(),
});

/**
 * Das Original darf erst dann aus dem Forderungsbestand verschwinden, wenn der
 * Korrekturbeleg in derselben Transaktion auf SENT festgeschrieben wurde.
 * Jeder Versandpfad (automatisch oder manuell) läuft durch diesen Helfer.
 */
async function cancelOriginalAfterDeliveredStornoTx(
  tx: TxClient,
  opts: { stornoId: string | null; originalId: string; staffId: string; tenantId: string },
): Promise<void> {
  const original = await tx.invoice.findUnique({
    where: { id: opts.originalId },
    select: { id: true, number: true, status: true },
  });
  if (!original) throw new ActionError('Originalrechnung zum Korrekturbeleg wurde nicht gefunden.');
  if (original.status === 'CANCELLED') return;
  if (!isValidInvoiceTransition(original.status, 'CANCELLED')) {
    throw new ActionError(
      `Originalrechnung kann aus Status ${original.status} nicht storniert werden.`,
    );
  }

  const claimed = await tx.invoice.updateMany({
    where: { id: original.id, status: original.status },
    data: { status: 'CANCELLED' },
  });
  if (claimed.count === 0) {
    throw new ActionError(
      'Originalrechnung wurde zwischenzeitlich geändert — bitte erneut prüfen.',
    );
  }
  await resolveNotificationsTx(tx, {
    tenantId: opts.tenantId,
    resources: [{ resourceType: 'invoice', resourceId: original.id }],
  });

  // Eine bereits bezahlte Leistung bleibt verbucht; andernfalls darf sie erst
  // JETZT — nach wirksamer Korrektur — wieder in den Abrechnungspool.
  const released =
    original.status === 'PAID'
      ? { count: 0 }
      : await tx.timeEntry.updateMany({
          where: { invoiceId: original.id },
          data: { invoiceId: null },
        });
  await evidenceService.record(tx, {
    tenantId: opts.tenantId,
    actorType: 'STAFF',
    actorId: opts.staffId,
    action: 'invoice.cancel',
    resourceType: 'invoice',
    resourceId: original.id,
    after: {
      number: original.number,
      releasedTimeEntries: released.count,
      stornoInvoiceId: opts.stornoId,
      refundDue: original.status === 'PAID',
    },
  });
}

// Festschreibe-Kern des Rechnungsversands, in der übergebenen Transaktion:
// atomarer DRAFT→SENT-Claim (TOCTOU-Schutz — nur der erste konkurrierende
// Versand trifft status=DRAFT), Portal-Freigabe der Archivkopie (der Archiv-
// Helfer lief noch im Status DRAFT und hat bewusst nicht freigegeben) und die
// invoice.send-Evidence. Rückgabe: die aktualisierte Rechnung, oder null wenn
// der Claim verloren ging (der gewünschte Endzustand SENT ist dann durch den
// konkurrierenden Request bereits erreicht). Gemeinsam genutzt von
// markSentAction (Normalversand) und cancelInvoiceAction (Storno-Beleg), damit
// die Sequenz nicht zwischen beiden Pfaden driftet.
async function finalizeInvoiceSendTx(
  tx: TxClient,
  opts: {
    invoiceId: string;
    staffId: string;
    tenantId: string;
    auditExtra?: Record<string, unknown>;
  },
) {
  // Der finale CAS teilt den Lock mit Archiv-Link und Entwurfsstorno. Damit
  // kann kein Storno DRAFT lesen, während der Versand danach unbemerkt SENT
  // claimt (oder umgekehrt).
  await lockInvoiceArchiveTx(tx, opts.invoiceId);
  const claim = await claimInvoiceDraftForSend(tx, opts.invoiceId);
  if (claim.outcome !== 'sent') return claim;

  const updated = claim.invoice;
  if (updated.stornoOfId) {
    // INV-LIFECYCLE-FREEZE-001: payments lock the original before writing audit.
    // Match that order before invoice.send acquires the tenant audit lock;
    // otherwise payment (original -> audit) and cancellation (audit -> original)
    // can deadlock. Re-read the status in the cancellation helper after this lock.
    const originals = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM public.invoice
      WHERE id = ${updated.stornoOfId}::uuid AND tenant_id = ${opts.tenantId}::uuid
      FOR UPDATE
    `;
    if (originals.length !== 1) {
      throw new ActionError('Originalrechnung zum Korrekturbeleg wurde nicht gefunden.');
    }
  }
  if (updated.documentId) {
    await tx.document.updateMany({
      where: { id: updated.documentId, sharedWithClientAt: null },
      data: { sharedWithClientAt: new Date(), sharedByStaff: opts.staffId },
    });
  }
  if (updated.xrechnungDocumentId) {
    await tx.document.updateMany({
      where: { id: updated.xrechnungDocumentId, sharedWithClientAt: null },
      data: { sharedWithClientAt: new Date(), sharedByStaff: opts.staffId },
    });
  }
  await evidenceService.record(tx, {
    tenantId: opts.tenantId,
    actorType: 'STAFF',
    actorId: opts.staffId,
    action: 'invoice.send',
    resourceType: 'invoice',
    resourceId: updated.id,
    after: { number: updated.number, sentAt: updated.sentAt, ...opts.auditExtra },
  });
  if (updated.stornoOfId) {
    await cancelOriginalAfterDeliveredStornoTx(tx, {
      stornoId: updated.id,
      originalId: updated.stornoOfId,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    });
  }
  return { outcome: 'sent' as const, invoice: updated };
}

type NonSentInvoiceResult = Exclude<
  Awaited<ReturnType<typeof finalizeInvoiceSendTx>>,
  { outcome: 'sent' }
>;

function markSentCasResult(result: NonSentInvoiceResult): ActionResult {
  switch (result.outcome) {
    case 'already_sent':
      return { ok: true };
    case 'not_found':
      return { ok: false, error: 'Rechnung nicht gefunden.' };
    case 'conflict':
      return {
        ok: false,
        error:
          result.status === 'CANCELLED'
            ? 'Versand abgebrochen: Die Rechnung wurde zwischenzeitlich storniert.'
            : `Versand abgebrochen: Die Rechnung hat inzwischen den Status ${result.status}.`,
      };
  }
}

async function enqueueInvoiceSentMailsTx(
  tx: TxClient,
  tenantId: string,
  sent: Extract<Awaited<ReturnType<typeof finalizeInvoiceSendTx>>, { outcome: 'sent' }>['invoice'],
): Promise<void> {
  // Mandant über den Versand informieren. Template-Slug 'invoice-sent' — falls
  // im ACP keines definiert ist, greift der Fallback (hartcodiert). F-08: im
  // Festschreibungs-Commit als Versandauftrag je Empfänger; der Worker stellt
  // mit Retry zu, ein Mail-Fehler scheitert den Rechnungs-Versand weiterhin nicht.
  const client = await tx.client.findUnique({
    where: { id: sent.clientId },
    select: {
      name: true,
      invoiceEmail: true,
      contacts: {
        where: { active: true, notificationsEnabled: true },
        select: { email: true, fullName: true },
      },
    },
  });
  const recipients = new Map<string, { email: string; fullName: string }>();
  if (client?.invoiceEmail) {
    recipients.set(client.invoiceEmail.toLowerCase(), {
      email: client.invoiceEmail,
      fullName: client.name,
    });
  }
  for (const contact of client?.contacts ?? []) {
    recipients.set(contact.email.toLowerCase(), contact);
  }
  for (const recipient of recipients.values()) {
    await enqueueDirectMailTx(
      tx,
      {
        tenantId,
        clientId: sent.clientId,
        purpose: 'invoice-sent',
        resource: { type: 'invoice', id: sent.id },
        staffHref: `/staff/invoices/${sent.id}`,
      },
      {
        slug: 'invoice-sent',
        to: recipient.email,
        vars: {
          contact: { fullName: recipient.fullName, email: recipient.email },
          client: { name: client?.name ?? 'Mandant' },
          invoice: {
            number: sent.number,
            total: fmtEUR(Number(sent.totalAmount.toString())),
            dueDate: sent.dueDate ? fmtDateShort(sent.dueDate) : '—',
          },
          link: `${portalBaseUrl}/portal/invoices`,
        },
        fallback: {
          subject: 'Neue Rechnung {{invoice.number}}',
          bodyMd:
            'Sehr geehrte/r {{contact.fullName}},\n\n' +
            'eine neue Rechnung ({{invoice.number}}) über {{invoice.total}} steht in Ihrem Mandantenportal bereit.\n' +
            'Fälligkeit: {{invoice.dueDate}}\n\n' +
            'Zur Übersicht: {{link}}',
        },
      },
    );
  }
}

export async function markSentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // iter87: Versenden = GoB-Festschreibung — eigenes Einzelrecht INVOICE_SEND.
  const g = await staffActionGuard({ requirePermission: 'INVOICE_SEND', modeModule: 'invoices' });
  if (!g.ok) {
    // Befund 9: Guard-Ablehnung strukturiert loggen UND an die UI zurückmelden
    // (früher Form-Action ohne Result-Channel → kommentarlos verschluckt).
    log.warn(
      { component: 'invoices', action: 'markSent', err: g.error },
      'markSentAction: Guard abgelehnt',
    );
    return { ok: false, error: g.error };
  }
  const { tenantId, staffId, ctx } = g;
  const parsed = parseFormData(StatusSchema, formData);
  if (!parsed.ok) {
    log.warn({ component: 'invoices', action: 'markSent' }, 'markSentAction: ungültige invoiceId');
    return { ok: false, error: 'Ungültige Rechnungs-ID.' };
  }

  // iter85 (GoB): Precondition + Archiv-PFLICHT vor dem Versand.
  // Nur DRAFT → SENT; und die byte-stabile GoBD-Archivkopie muss VOR der
  // Festschreibung existieren — vorher war das Archiv best-effort und eine
  // SENT-Rechnung konnte ohne revisionssichere Kopie existieren (Befund 8).
  // PDF-/EXTERNAL-Formate haben kein Generat (not_applicable) und passieren.
  let current;
  try {
    current = await withTenantContext(ctx, async (tx) => {
      const inv = await tx.invoice.findUnique({
        where: { id: parsed.data.invoiceId },
        select: { status: true, clientId: true, documentId: true, format: true },
      });
      // Vertraulich-/RESTRICTED-Ventil.
      if (inv) await assertClientAccessTx(tx, g.session, inv.clientId);
      return inv;
    });
  } catch (e) {
    return toActionError(e);
  }
  if (!current) return { ok: false, error: 'Rechnung nicht gefunden.' };
  if (!isValidInvoiceTransition(current.status, 'SENT')) {
    return { ok: false, error: `Statuswechsel ${current.status} → SENT ist nicht zulässig.` };
  }

  let archive;
  try {
    archive = await withTimeout(
      ensureZugferdArchive(ctx, parsed.data.invoiceId, { purpose: 'ISSUE' }),
      45_000,
    );
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof TimeoutError
          ? 'ZUGFeRD-Archiv konnte nicht rechtzeitig erzeugt werden — bitte erneut versuchen.'
          : `ZUGFeRD-Archiv konnte nicht erzeugt werden: ${toActionError(err).error}`,
    };
  }
  if (!archive.ok) {
    if (archive.code !== 'not_applicable') {
      return {
        ok: false,
        error: `Versand abgebrochen — GoBD-Archivkopie konnte nicht erstellt werden: ${archiveFailureMessage(archive.code)}`,
      };
    }
    // H-4: `not_applicable` ist nur für EXTERNAL-Uploads zulässig (deren
    // documentId IST die Rechnung). Eine IN_APP-Rechnung mit Format „PDF" hat
    // KEIN Generat und KEIN Dokument — sie darf nicht ohne Rechnungsbeleg
    // versendet werden (§ 14 Abs. 1 UStG, keine GoBD-Archivkopie).
    if (!current.documentId) {
      return {
        ok: false,
        error:
          'Diese Rechnung hat kein Rechnungsdokument (Format „PDF" ohne Beleg). ' +
          'Bitte als XRechnung oder ZUGFeRD neu anlegen.',
      };
    }
  }

  // TOCTOU-Schutz gegen Doppel-Submit (zwei Tabs / zwei Bearbeiter): beide
  // passieren den Precheck oben, aber der atomare DRAFT→SENT-Claim im Helfer
  // trifft nur beim ersten status=DRAFT — der zweite läuft ins Leere (null).
  const sendResult = await withTenantContext(ctx, async (tx) => {
    const result = await finalizeInvoiceSendTx(tx, {
      invoiceId: parsed.data.invoiceId,
      staffId,
      tenantId,
    });
    if (result.outcome === 'sent') await enqueueInvoiceSentMailsTx(tx, tenantId, result.invoice);
    return result;
  });

  // Nur ein tatsächlich bereits ausgelieferter Zustand ist idempotenter Erfolg.
  // Hat parallel ein Storno gewonnen, darf weder Erfolg noch Zustellung/N8N
  // gemeldet werden.
  if (sendResult.outcome !== 'sent') return markSentCasResult(sendResult);
  const sent = sendResult.invoice;
  kickMailOutboxDelivery();

  // Korrekturbelege dürfen niemals den normalen Fälligkeits-/Mahnworkflow
  // starten. finalizeInvoiceSendTx hat das Original bereits atomar storniert.
  await emitN8nEvent(
    sent.stornoOfId ? 'invoice.storno' : 'invoice.due',
    {
      tenantId,
      invoiceId: parsed.data.invoiceId,
    },
    { tenantId },
  );
  revalidatePath('/staff/invoices');
  revalidatePath(`/staff/invoices/${parsed.data.invoiceId}`);
  return { ok: true };
}

export async function markPaidAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseFormData(StatusSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültige Rechnungs-ID.' };

  // Ablehnung (z. B. unzulässiger Statuswechsel bei veralteter Seite) geht als
  // Ergebnis an die UI — der Dialog zeigt den Grund statt eines No-ops.
  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // iter85: Precondition (UI verbirgt den Button, die Action prüft selbst;
      // der DB-Trigger ist der Backstop).
      const current = await tx.invoice.findUnique({
        where: { id: parsed.data.invoiceId },
        select: { status: true, clientId: true },
      });
      if (!current) throw new ActionError('Rechnung nicht gefunden.');
      await assertClientAccessTx(tx, session, current.clientId);
      if (!isValidInvoiceTransition(current.status, 'PAID')) {
        throw new ActionError(`Statuswechsel ${current.status} → PAID ist nicht zulässig.`);
      }
      const updated = await claimInvoicePayment(tx, tenantId, parsed.data.invoiceId);
      if (!updated) {
        throw new ActionError(
          'Der Rechnungsstatus hat sich geändert. Bitte die Rechnung neu laden.',
        );
      }
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'invoice', resourceId: parsed.data.invoiceId }],
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
    {
      requirePermission: 'INVOICE_MANAGE',
      modeModule: 'invoices',
      revalidate: ['/staff/invoices', `/staff/invoices/${parsed.data.invoiceId}`],
    },
  );
}

export async function cancelInvoiceAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({
    requirePermission: 'INVOICE_MANAGE',
    modeModule: 'invoices',
  });
  if (!g.ok) return { ok: false, error: g.error ?? 'Nicht berechtigt.' };
  const parsed = parseFormData(StatusSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültige Rechnungs-ID.' };
  try {
    await cancelInvoice(g, parsed.data.invoiceId);
  } catch (e) {
    return toActionError(e);
  }
  return { ok: true };
}

/** Storno-Ablauf; Fachfehler werfen ActionError und kommen über cancelInvoiceAction zurück. */
async function cancelInvoice(
  { tenantId, staffId, ctx, session }: StaffCtx,
  invoiceId: string,
): Promise<void> {
  // Tx A erzeugt bei einer bereits ausgestellten Rechnung NUR den
  // Korrekturbeleg-Entwurf. Das Original bleibt aktiv, bis der Beleg unten
  // revisionssicher erzeugt und auf SENT festgeschrieben ist. Ein nie
  // ausgestellter DRAFT kann dagegen unmittelbar abgebrochen werden.
  let stornoId: string | null = null;
  try {
    await withTenantContext(ctx, async (tx) => {
      // Derselbe Lock wie beim Archiv-Link: Entwurfsstorno und erstmalige
      // Archivverknüpfung dürfen sich nicht überholen.
      await lockInvoiceArchiveTx(tx, invoiceId);
      const current = await tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { positions: { orderBy: { position: 'asc' } } },
      });
      if (!current) throw new ActionError('Rechnung nicht gefunden.');
      await assertClientAccessTx(tx, session, current.clientId);
      if (!isValidInvoiceTransition(current.status, 'CANCELLED')) {
        throw new ActionError(`Statuswechsel ${current.status} → CANCELLED ist nicht zulässig.`);
      }

      const wasPaid = current.status === 'PAID';
      const wasDelivered = current.status === 'SENT' || current.status === 'OVERDUE' || wasPaid;
      if (!wasDelivered) {
        // Ein nie ausgelieferter Entwurf ist kein GoBD-Rechnungsbeleg. Bereits
        // per Kontroll-Download erzeugte App-Archive werden von der Rechnung
        // gelöst und soft-deleted; Object-Lock-Bytes bleiben regelkonform bis
        // zum Retention-Ende erhalten. EXTERNAL/PDF wird hier nie verändert.
        const discarded = await discardNeverSentDraftArchiveTx(tx, current, staffId);
        if (discarded) {
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'invoice.archive.discard_draft',
            resourceType: 'invoice',
            resourceId: invoiceId,
            after: discarded,
          });
        }
        await cancelOriginalAfterDeliveredStornoTx(tx, {
          stornoId: null,
          originalId: invoiceId,
          staffId,
          tenantId,
        });
        return;
      }

      // Ein PDF-Original stammt aus dem Fremdsystem. Ohne den dort erzeugten
      // und hochgeladenen Korrekturbeleg darf die App den offenen Posten nicht
      // entfernen oder die Zeiten freigeben.
      if (current.format === 'PDF') {
        throw new ActionError(
          'Externe PDF-Rechnung bleibt aktiv. Bitte den Korrekturbeleg zuerst im Fremdsystem ausstellen und dokumentieren.',
        );
      }

      const existing = await tx.invoice.findFirst({
        where: { tenantId, stornoOfId: current.id },
        select: { id: true, status: true },
      });
      if (existing) {
        if (existing.status === 'CANCELLED') {
          throw new ActionError(
            'Der vorhandene Korrekturbeleg wurde abgebrochen. Bitte fachlich prüfen.',
          );
        }
        stornoId = existing.id;
        return;
      }

      const negate = (value: { toString(): string }) => -Number(value.toString());
      const stornoDate = berlinTodayUtcMidnight();
      const number = await allocateInvoiceNumber(tx, tenantId, stornoDate);
      const storno = await tx.invoice.create({
        data: {
          tenantId,
          clientId: current.clientId,
          number,
          subject: `Storno zu ${current.number}: ${current.subject}`.slice(0, 500),
          issueDate: stornoDate,
          dueDate: stornoDate,
          servicePeriodStart: current.servicePeriodStart,
          servicePeriodEnd: current.servicePeriodEnd,
          status: 'DRAFT',
          format: current.format,
          netAmount: negate(current.netAmount),
          vatAmount: negate(current.vatAmount),
          totalAmount: negate(current.totalAmount),
          vatRate: current.vatRate,
          vatExemptionReason: current.vatExemptionReason,
          reverseCharge: current.reverseCharge,
          categoryId: current.categoryId,
          stornoOfId: current.id,
          notes: wasPaid
            ? 'Original war bereits BEZAHLT — Rückzahlung/Zahlungsrückabwicklung gesondert veranlassen (kein automatischer Zahlungsfluss).'
            : null,
          createdByStaff: staffId,
          positions: { create: current.positions.map(toStornoPosition) },
        },
      });
      stornoId = storno.id;
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.storno.create',
        resourceType: 'invoice',
        resourceId: storno.id,
        after: {
          number,
          stornoOf: current.number,
          totalAmount: negate(current.totalAmount),
        },
      });
    });
  } catch (e) {
    // Der partielle Unique-Index ist der DB-Backstop für zwei gleichzeitig
    // angelegte Korrekturbelege. Der Verlierer verwendet sauber den Gewinner,
    // statt einen technischen P2002 anzuzeigen.
    if ((e as { code?: string }).code === 'P2002') {
      const existing = await withTenantContext(ctx, (tx) =>
        tx.invoice.findFirst({
          where: { tenantId, stornoOfId: invoiceId },
          select: { id: true },
        }),
      );
      if (existing) stornoId = existing.id;
      else
        throw new ActionError('Korrekturbeleg wurde parallel angelegt — bitte erneut versuchen.');
    } else {
      if (e instanceof ActionError) throw e;
      throw new ActionError(toActionError(e).error ?? 'Storno fehlgeschlagen.');
    }
  }

  if (stornoId) {
    let archive;
    try {
      archive = await withTimeout(
        ensureZugferdArchive(ctx, stornoId, { purpose: 'ISSUE' }),
        45_000,
      );
    } catch (error) {
      log.warn(
        { component: 'invoices', action: 'storno-send', stornoId, err: (error as Error).message },
        'Korrekturbeleg nicht versendet; Original bleibt aktiv',
      );
      throw new ActionError(
        'Korrekturbeleg konnte nicht erzeugt werden. Das Original bleibt aktiv; der Entwurf kann erneut versendet werden.',
      );
    }
    if (!archive.ok) {
      throw new ActionError(
        `Korrekturbeleg nicht versendet; Original bleibt aktiv: ${archiveFailureMessage(archive.code)}`,
      );
    }

    const result = await withTenantContext(ctx, async (tx) => {
      const sendResult = await finalizeInvoiceSendTx(tx, {
        invoiceId: stornoId!,
        staffId,
        tenantId,
        auditExtra: { storno: true },
      });
      if (sendResult.outcome === 'sent') return { newlySent: true };

      // Retry/Parallelfall: Der Korrekturbeleg kann bereits SENT sein. Dann
      // wird nur noch idempotent sichergestellt, dass das Original storniert ist.
      const existing =
        sendResult.outcome === 'already_sent'
          ? sendResult.invoice
          : await tx.invoice.findUnique({
              where: { id: stornoId! },
              select: { id: true, status: true, stornoOfId: true },
            });
      if (
        existing?.stornoOfId === invoiceId &&
        ['SENT', 'OVERDUE', 'PAID'].includes(existing.status)
      ) {
        await cancelOriginalAfterDeliveredStornoTx(tx, {
          stornoId: existing.id,
          originalId: invoiceId,
          staffId,
          tenantId,
        });
        return { newlySent: false };
      }
      throw new ActionError(
        'Korrekturbeleg konnte nicht festgeschrieben werden; Original bleibt aktiv.',
      );
    });
    if (result.newlySent) {
      await emitN8nEvent('invoice.storno', { tenantId, invoiceId: stornoId }, { tenantId });
    }
  }

  revalidatePath('/staff/invoices');
  revalidatePath(`/staff/invoices/${invoiceId}`);
  if (stornoId) revalidatePath(`/staff/invoices/${stornoId}`);
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
  number: z
    .string()
    .min(1)
    .max(50)
    .refine((n) => !RESERVED_AUTO_NUMBER.test(n), {
      message:
        'Diese Nummer hat das Format des automatischen Nummernkreises (JJJJ-NNNN) und ist reserviert. Bitte die Originalnummer des Fremdsystems verwenden.',
    }),
  subject: z.string().min(1).max(200),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  totalAmount: z.coerce
    .number()
    .min(0)
    .max(100_000_000)
    .refine((n) => round2(n) === n, {
      message: 'Bruttobetrag darf höchstens zwei Nachkommastellen haben.',
    }),
  // USt-Satz des Fremdbelegs (0 = steuerfrei / Reverse-Charge / Kleinunternehmer).
  // Nur die deutschen Regelsätze; ohne diesen wäre Netto aus dem Brutto nicht
  // ableitbar und das Umsatz-KPI (netto) systematisch überhöht.
  vatRatePct: z.coerce.number().refine((v) => [0, 7, 19].includes(v), {
    message: 'USt-Satz muss 0, 7 oder 19 % sein.',
  }),
  notes: z.string().max(1000).nullable().optional(),
});

/** Metadaten der hochgeladenen PDF (vom File, F-09). */
const ExternalPdfMetaSchema = z.object({
  fileName: z.string().max(255),
  mimeType: z.string().max(100),
});

/**
 * Gemeinsame Vor- und Nachprüfung des Fremdrechnungs-Uploads (K-06 /
 * DOC-UPLOAD-JOURNAL-001): Mandantenzugriff, Mandant, Kategorie und freie
 * Rechnungsnummer vor dem GoBD-Object-Write (achtjährig unlöschbar) und erneut
 * in der Commit-Transaktion.
 */
async function checkExternalInvoiceTx(
  tx: TxClient,
  session: StaffCtx['session'],
  tenantId: string,
  data: z.infer<typeof UploadExternalSchema>,
) {
  const cat = data.categoryId
    ? await tx.invoiceCategory.findUnique({
        where: { id: data.categoryId },
        select: { id: true, emailTemplateSlug: true, name: true },
      })
    : null;

  await assertClientAccessTx(tx, session, data.clientId);
  const cli = await tx.client.findUnique({
    where: { id: data.clientId },
    select: {
      name: true,
      contacts: {
        where: { active: true, notificationsEnabled: true },
        select: { email: true, fullName: true },
      },
    },
  });
  if (!cli) throw new ActionError('Mandant nicht gefunden.');
  const taken = await tx.invoice.findFirst({
    where: { tenantId, number: data.number },
    select: { id: true },
  });
  if (taken) throw new ActionError('Rechnungsnummer bereits vergeben.');
  return {
    mailTemplateSlug: cat?.emailTemplateSlug ?? null,
    clientName: cli.name,
    recipients: cli.contacts,
  };
}

/**
 * F-09: Die PDF kommt als `File` in `upload` (FormData-Feld `pdf`), nicht mehr
 * als base64-String im Action-Body; Grenze aus src/lib/upload-limits.mjs.
 */
export async function uploadExternalInvoiceAction(
  input: z.infer<typeof UploadExternalSchema>,
  upload: FormData,
): Promise<{
  ok: boolean;
  error?: string;
  id?: string;
}> {
  // iter87: EXTERNAL-Upload stellt aus UND stellt zu (Mail an Mandanten) —
  // das ist der Versand-Akt, daher INVOICE_SEND statt INVOICE_MANAGE.
  const g = await staffActionGuard({ requirePermission: 'INVOICE_SEND', modeModule: 'invoices' });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const gate = await requireInvoiceMode(ctx, 'EXTERNAL');
  if (gate) return gate;

  const parsed = UploadExternalSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  const data = parsed.data;

  // EXTERNAL: erfasst wird der Brutto-Gesamtbetrag + der USt-Satz der Fremd-PDF.
  // Netto/USt daraus ableiten, damit die Umsatz-KPIs (netto) nicht den Brutto-
  // betrag als Netto zählen. USt = Brutto − Netto → summiert exakt auf Brutto.
  // Bei 0 % (steuerfrei/Reverse-Charge) ist Netto = Brutto, USt = 0.
  const grossAmount = data.totalAmount;
  const netAmount = Math.round((grossAmount / (1 + data.vatRatePct / 100)) * 100) / 100;
  const vatAmount = Math.round((grossAmount - netAmount) * 100) / 100;

  const pdf = await readUploadFile(upload, 'pdf', 'externalInvoicePdf', {
    missing: 'Bitte eine PDF-Datei auswählen.',
    empty: 'PDF-Daten leer.',
    tooLarge: 'PDF zu groß',
  });
  if (!pdf.ok) return { ok: false, error: pdf.error };
  const pdfMeta = ExternalPdfMetaSchema.safeParse({
    fileName: pdf.fileName,
    mimeType: pdf.mimeType || 'application/pdf',
  });
  if (!pdfMeta.success)
    return { ok: false, error: 'Dateiname oder Dateityp der PDF ist ungültig.' };
  const pdfBytes = pdf.bytes;

  // 1) Vorprüfung, PDF als Speicherabsicht journalisieren und in Object-Lock
  //    (Rechnungs-Aufbewahrung 8 J.) ablegen; 2) Nachprüfung + Document +
  //    Invoice + Audit + Versandaufträge + Abschluss der Absicht in einer
  //    Transaktion (K-06, F-08).
  let invoiceId: string;
  try {
    const { result } = await runJournaledUpload({
      context: ctx,
      source: 'staff.external_invoice.pdf',
      check: (tx) => checkExternalInvoiceTx(tx, g.session, tenantId, data),
      readBytes: async () => pdfBytes,
      storage: () => ({ tier: 'GOBD', classification: 'GOBD_INVOICE' }),
      commitTx: async (tx, { commit: stored, checked }) => {
        // Befund 12: Document+Version-Insert zentral (upload-helpers).
        const { document: doc, version } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId,
            clientId: data.clientId,
            title: `Rechnung ${data.number}: ${data.subject}`,
            classification: 'GOBD_INVOICE',
            // P-3: Magic-Bytes statt Client-Header — siehe M-2.
            mimeType: stored.detectedMime ?? pdfMeta.data.mimeType,
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
            netAmount,
            vatAmount,
            totalAmount: grossAmount,
            // Aus Brutto + erfasstem USt-Satz abgeleitet (siehe oben).
            vatRate: data.vatRatePct,
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

        // 3) Mail mit PDF-Anhang an aktive Kontakte mit Opt-in — F-08: als
        // Versandauftrag je Empfänger; der Anhang ist die eben gespeicherte,
        // hashgebundene Fassung.
        for (const r of checked.recipients) {
          await enqueueDirectMailTx(
            tx,
            {
              tenantId,
              clientId: input.clientId,
              purpose: 'invoice-external',
              resource: { type: 'invoice', id: inv.id },
              staffHref: `/staff/invoices/${inv.id}`,
            },
            {
              slug: checked.mailTemplateSlug ?? 'invoice-sent',
              to: r.email,
              vars: {
                contact: { fullName: r.fullName, email: r.email },
                client: { name: checked.clientName },
                invoice: {
                  number: input.number,
                  subject: input.subject,
                  totalAmount: input.totalAmount,
                  dueDate: input.dueDate,
                },
              },
              n8nEvent: 'invoice.due',
              n8nPayload: { tenantId, invoiceId: inv.id },
              fallback: {
                subject: 'Ihre Rechnung {{invoice.number}}',
                bodyMd:
                  'Sehr geehrte/r {{contact.fullName}},\n\nanbei senden wir Ihnen unsere Rechnung Nr. {{invoice.number}} über {{invoice.totalAmount}} €.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
              },
              attachments: [
                {
                  documentVersionId: version.id,
                  filename: `Rechnung-${input.number}.pdf`,
                  contentType: 'application/pdf',
                },
              ],
            },
          );
        }

        return inv.id;
      },
    });
    invoiceId = result;
  } catch (error) {
    // Nach dem Object-Write bleibt die Speicherabsicht offen; der Cleanup-Worker
    // räumt das Objekt nach der Sicherheitsfrist versionsgenau auf.
    const e = uploadFailureCause(error);
    if (
      error instanceof JournaledUploadError &&
      (error.phase === 'prepare' || error.phase === 'store')
    ) {
      return { ok: false, error: `Storage-Fehler: ${toActionError(e).error}` };
    }
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Rechnungsnummer bereits vergeben.' };
    }
    return toActionError(e);
  }

  kickMailOutboxDelivery();

  revalidatePath('/staff/invoices');
  revalidatePath(`/portal/invoices`);
  return { ok: true, id: invoiceId };
}
