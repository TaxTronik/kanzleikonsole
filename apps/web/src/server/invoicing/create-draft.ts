// =============================================================================
// Anlage eines In-App-Rechnungsentwurfs — ein Pfad für manuelle Rechnungen,
// Stundenabrechnungen und StBVV-Übernahmen.
//
// Reihenfolge (alle Prüfungen VOR der Nummernvergabe, INV-NUMBER-ALLOCATION-001):
// 1. reine Eingabeprüfungen (checkDraftInvoice): Rechnungsjahr, Leistungs-
//    zeitraum, USt-Satz-Whitelist, Reverse-Charge nur mit 0 %, 0 % nur mit
//    Befreiungsgrund (INV-VAT-TOTALS-001), Speicherpräzision und
//    Decimal-Grenzen je Position und für die Kopfsummen;
// 2. § 13b UStG: USt-IdNr der Kanzlei (BT-31, BR-AE-01) und des Mandanten
//    (BT-48) in derselben Transaktion;
// 3. Nummer + Kopf + Positionen in derselben Transaktion, einheitliche
//    Fehlerabbildung (Nummernkonflikt, GwG-Schranke);
// 4. quellenspezifischer Claim (Zeiteinträge, StBVV-Kalkulation) und Audit.
//
// Der Aufrufer prüft vorher in derselben Transaktion den Mandantenzugriff
// (assertClientAccessTx) und seine Modul-/Modus-Gates.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { round2 } from '@/lib/fmt';
import { ActionError } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { archiveFailureMessage } from '@/server/invoicing/archive-failure';
import { allocateInvoiceNumber } from '@/server/invoicing/number';
import { claimTimeEntriesForInvoice } from '@/server/invoicing/time-billing';
import { computeVatTotals, vatInputError, type VatTotals } from '@/server/invoicing/vat';
import { readSellerInfoTx } from '@/server/settings/tenant-settings';

/** Decimal(12,2): Positionsnetto und Kopfsummen. */
const MAX_AMOUNT = 9_999_999_999.99;
/** Decimal(10,2): Menge und Einzelpreis einer Position. */
const MAX_POSITION_VALUE = 99_999_999.99;

export interface DraftInvoiceCtx {
  tenantId: string;
  staffId: string;
}

export interface DraftInvoiceHeader {
  clientId: string;
  subject: string;
  issueDate: Date;
  dueDate: Date;
  servicePeriodStart: Date | null;
  servicePeriodEnd: Date | null;
  vatExemptionReason: string | null;
  reverseCharge: boolean;
  format: 'XRECHNUNG' | 'ZUGFERD';
  notes: string | null;
}

/** Position ohne Nummer und Netto: beides bildet der Service. */
export interface DraftInvoicePositionInput {
  description: string;
  quantity: number;
  unitPrice: number;
  unit: string;
  vatRate: number;
}

export interface DraftInvoicePosition extends DraftInvoicePositionInput {
  position: number;
  netAmount: number;
}

export type DraftInvoiceSource =
  | { kind: 'manual' }
  /** INV-TIME-ENTRY-CLAIM-001: alle IDs werden atomar auf den Entwurf gesetzt. */
  | { kind: 'time_entries'; entryIds: string[]; strategy: 'one-line' | 'per-entry' }
  /** STBVV-CALCULATION-001: die Kalkulation wird genau einmal übernommen. */
  | { kind: 'stbvv_quote'; quoteId: string };

export type CheckedDraftInvoice =
  | { ok: true; positions: DraftInvoicePosition[]; totals: VatTotals }
  | { ok: false; error: string };

export interface CreatedDraftInvoice {
  id: string;
  number: string;
  totals: VatTotals;
}

/**
 * Das Rechnungsdatum bestimmt den Jahres-Nummernkreis (allocateInvoiceNumber).
 * Ein frei rück-/vordatiertes Datum würde einen fremden Jahreskreis öffnen —
 * daher laufendes Jahr ± 1 (deckt die Jahreswechsel-Grenze ab).
 */
export function issueYearPlausible(issueDate: Date, now = new Date()): boolean {
  const year = issueDate.getUTCFullYear();
  const current = now.getUTCFullYear();
  return year >= current - 1 && year <= current + 1;
}

/** Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG): beide Grenzen oder keine, Start ≤ Ende. */
export function servicePeriodError(start: Date | null, end: Date | null): string | null {
  if ((start === null) !== (end === null)) {
    return 'Leistungszeitraum braucht Start UND Ende (oder beides leer).';
  }
  if (start && end && start.getTime() > end.getTime()) {
    return 'Leistungszeitraum: Start liegt nach dem Ende.';
  }
  return null;
}

function positionError(position: DraftInvoicePositionInput): string | null {
  const { quantity, unitPrice } = position;
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
    return 'Menge und Einzelpreis müssen Zahlen sein.';
  }
  // EN 16931 BR-27: Einzelpreis nicht negativ; Gutschriften laufen über den
  // Korrekturbeleg, nicht über einen Entwurf.
  if (quantity < 0 || unitPrice < 0) return 'Menge und Einzelpreis dürfen nicht negativ sein.';
  if (round2(quantity) !== quantity || round2(unitPrice) !== unitPrice) {
    return 'Menge und Einzelpreis dürfen höchstens zwei Nachkommastellen haben.';
  }
  if (quantity > MAX_POSITION_VALUE || unitPrice > MAX_POSITION_VALUE) {
    return 'Menge oder Einzelpreis zu groß (max. 99.999.999,99).';
  }
  if (quantity * unitPrice > MAX_AMOUNT) {
    return 'Positionsbetrag zu groß (max. 9.999.999.999,99 €).';
  }
  return null;
}

/**
 * Reine Prüfung und Berechnung eines Entwurfs (ohne DB). Aufrufer können sie
 * vor dem Öffnen einer Transaktion nutzen; createDraftInvoiceTx wiederholt sie.
 */
export function checkDraftInvoice(
  header: DraftInvoiceHeader,
  positions: readonly DraftInvoicePositionInput[],
): CheckedDraftInvoice {
  if (!issueYearPlausible(header.issueDate)) {
    return {
      ok: false,
      error: 'Rechnungsdatum liegt außerhalb des plausiblen Bereichs (laufendes Jahr ± 1).',
    };
  }
  const periodError = servicePeriodError(header.servicePeriodStart, header.servicePeriodEnd);
  if (periodError) return { ok: false, error: periodError };
  if (positions.length === 0)
    return { ok: false, error: 'Mindestens eine Position ist erforderlich.' };
  for (const position of positions) {
    const error = positionError(position);
    if (error) return { ok: false, error };
  }
  const taxError = vatInputError({
    vatRates: positions.map((position) => position.vatRate),
    reverseCharge: header.reverseCharge,
    vatExemptionReason: header.vatExemptionReason,
  });
  if (taxError) return { ok: false, error: taxError };

  // Beträge serverseitig — USt je Satz-Gruppe (§ 14 Abs. 4 Nr. 8 UStG, iter86).
  const numbered = positions.map((position, index) => ({
    position: index + 1,
    description: position.description,
    quantity: position.quantity,
    unitPrice: position.unitPrice,
    unit: position.unit,
    netAmount: round2(position.quantity * position.unitPrice),
    vatRate: position.vatRate,
  }));
  const totals = computeVatTotals(numbered);
  // Decimal(12,2) gilt auch für den Kopf: USt oder mehrere einzeln zulässige
  // Positionen können die Spalten gemeinsam überschreiten.
  if (
    [totals.netAmount, totals.vatAmount, totals.totalAmount].some(
      (amount) => !Number.isFinite(amount) || amount > MAX_AMOUNT,
    )
  ) {
    return {
      ok: false,
      error:
        'Rechnungssumme zu groß: Netto, Umsatzsteuer und Brutto dürfen jeweils höchstens 9.999.999.999,99 € betragen.',
    };
  }
  return { ok: true, positions: numbered, totals };
}

/** § 13b UStG: USt-IdNr der Kanzlei (BT-31, BR-AE-01) und des Mandanten (BT-48). */
async function assertReverseChargeVatIdsTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
): Promise<void> {
  // Die allgemeine Absender-Vollständigkeit akzeptiert USt-IdNr ODER
  // Steuernummer — für die Kategorie AE ist die USt-IdNr zwingend. Ohne sie
  // scheiterte der Entwurf erst beim Versand, nachdem er eine Nummer belegt.
  const seller = await readSellerInfoTx(tx, tenantId);
  if (!seller.vatId) {
    throw new ActionError(archiveFailureMessage('reverse_charge_seller_no_vatid'));
  }
  const client = await tx.client.findUnique({ where: { id: clientId }, select: { vatId: true } });
  if (!client?.vatId) {
    throw new ActionError(
      'Reverse-Charge (§ 13b UStG) erfordert eine hinterlegte USt-IdNr des Mandanten.',
    );
  }
}

/**
 * Einheitliche Fehlerabbildung der Anlage: Prisma-Code statt fragiler
 * Message-Substrings (P2002 = Nummernkonflikt); die GwG-Schranke ist ein
 * BEFORE-INSERT-Trigger (SQLSTATE check_violation), dessen Marker
 * „GwG-Schranke" der stabile Vertrag der Migrationen (init/iter2/iter5) ist.
 */
export function draftInvoiceDbError(error: unknown): unknown {
  if ((error as { code?: string }).code === 'P2002') {
    return new ActionError('Rechnungsnummer existiert bereits.');
  }
  if ((error as Error).message?.includes('GwG-Schranke')) {
    return new ActionError('Mandant ist nicht aktiv (GwG-Prüfung ausstehend).');
  }
  return error;
}

async function claimSourceTx(
  tx: TxClient,
  ctx: DraftInvoiceCtx,
  source: DraftInvoiceSource,
  invoiceId: string,
): Promise<void> {
  if (source.kind === 'time_entries') {
    // Ein paralleler Lauf darf den gelesenen invoiceId:null-Zustand nicht
    // überschreiben; bei Teil-/Nullclaim rollt die gesamte Tx inklusive
    // Rechnung und Nummernvergabe zurück.
    if (!(await claimTimeEntriesForInvoice(tx, source.entryIds, invoiceId))) {
      throw new ActionError(
        'Mindestens ein Zeiteintrag wurde zwischenzeitlich bereits abgerechnet. Bitte neu laden.',
      );
    }
  } else if (source.kind === 'stbvv_quote') {
    await tx.stbvvQuoteExport.create({
      data: { tenantId: ctx.tenantId, quoteId: source.quoteId, invoiceId },
    });
  }
}

function auditEvent(
  source: DraftInvoiceSource,
  header: DraftInvoiceHeader,
  number: string,
  totals: VatTotals,
): { action: string; after: Record<string, unknown> } {
  switch (source.kind) {
    case 'manual':
      return {
        action: 'invoice.create',
        after: {
          number,
          clientId: header.clientId,
          totalAmount: totals.totalAmount,
          format: header.format,
        },
      };
    case 'time_entries':
      return {
        action: 'invoice.create.from_time',
        after: {
          number,
          clientId: header.clientId,
          timeEntryCount: source.entryIds.length,
          totalAmount: totals.totalAmount,
          strategy: source.strategy,
        },
      };
    case 'stbvv_quote':
      return {
        action: 'stbvv.invoice.draft',
        after: {
          clientId: header.clientId,
          quoteId: source.quoteId,
          number,
          totalAmount: totals.totalAmount,
        },
      };
  }
}

/**
 * Legt einen In-App-Rechnungsentwurf an: alle Prüfungen, dann Nummer, Kopf,
 * Positionen, Quellen-Claim und Audit in der Transaktion des Aufrufers.
 * Fachliche Ablehnungen kommen als ActionError (vor jeder Nummernvergabe).
 */
export async function createDraftInvoiceTx(
  tx: TxClient,
  ctx: DraftInvoiceCtx,
  header: DraftInvoiceHeader,
  positions: readonly DraftInvoicePositionInput[],
  source: DraftInvoiceSource,
): Promise<CreatedDraftInvoice> {
  const checked = checkDraftInvoice(header, positions);
  if (!checked.ok) throw new ActionError(checked.error);
  if (header.reverseCharge) await assertReverseChargeVatIdsTx(tx, ctx.tenantId, header.clientId);

  const { totals } = checked;
  let invoice: { id: string; number: string };
  try {
    // Lückenlose Vergabe in DERSELBEN Tx: scheitert der INSERT, rollt die
    // Sequenz mit zurück — es entsteht keine Lücke.
    const number = await allocateInvoiceNumber(tx, ctx.tenantId, header.issueDate);
    const created = await tx.invoice.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: header.clientId,
        number,
        subject: header.subject,
        issueDate: header.issueDate,
        dueDate: header.dueDate,
        servicePeriodStart: header.servicePeriodStart,
        servicePeriodEnd: header.servicePeriodEnd,
        vatExemptionReason: header.vatExemptionReason,
        reverseCharge: header.reverseCharge,
        status: 'DRAFT',
        format: header.format,
        netAmount: totals.netAmount,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        // Kopf-Satz nur bei einheitlichem Satz (Anzeige/CSV); Mischsätze → null.
        vatRate: totals.uniformRate,
        notes: header.notes,
        createdByStaff: ctx.staffId,
        positions: { create: checked.positions },
      },
    });
    invoice = { id: created.id, number };
  } catch (error) {
    throw draftInvoiceDbError(error);
  }

  await claimSourceTx(tx, ctx, source, invoice.id);
  const audit = auditEvent(source, header, invoice.number, totals);
  await evidenceService.record(tx, {
    tenantId: ctx.tenantId,
    actorType: 'STAFF',
    actorId: ctx.staffId,
    action: audit.action,
    resourceType: 'invoice',
    resourceId: invoice.id,
    after: audit.after,
  });
  return { ...invoice, totals };
}
