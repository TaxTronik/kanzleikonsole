import { fmtDateShort, round2 } from '@/lib/fmt';
import { vatInputError } from '@/server/invoicing/vat';

export interface CalculatedTimeEntry {
  entry: { startedAt: Date; description: string };
  minutes: number;
  hours: number;
  rate: number;
  net: number;
}

export interface TimeBillingPosition {
  position: number;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  netAmount: number;
  vatRate: number;
}

/**
 * Steuer-Vorprüfung vor dem Laden der Zeiteinträge: dieselbe Regel wie jede
 * In-App-Anlage (vatInputError, INV-VAT-TOTALS-001); alle Positionen tragen
 * den gewählten Satz.
 */
export function validateTimeBillingTax(input: {
  vatRate: number;
  reverseCharge: boolean;
  vatExemptionReason: string | null;
}): string | null {
  return vatInputError({
    vatRates: [input.vatRate],
    reverseCharge: input.reverseCharge,
    vatExemptionReason: input.vatExemptionReason,
  });
}

/**
 * Bildet abrechenbare Zeiten auf EN-16931-rechenfeste Positionen ab.
 *
 * Decimal(10,2) kann 1/6 Stunde nicht exakt speichern. Eine gerundete Menge
 * 0,17 × 120 EUR ergäbe 20,40 EUR, obwohl zehn Minuten exakt 20,00 EUR kosten.
 * Deshalb ist jede Detailzeile ein Pauschalbetrag mit Menge 1; Dauer und
 * Stundensatz bleiben transparent in der Beschreibung.
 */
export function buildTimeBillingPositions(
  entries: CalculatedTimeEntry[],
  strategy: 'one-line' | 'per-entry',
  subject: string,
  vatRate: number,
): TimeBillingPosition[] {
  const totalNet = round2(entries.reduce((sum, entry) => sum + entry.net, 0));
  if (strategy === 'one-line') {
    const totalHours = round2(entries.reduce((sum, entry) => sum + entry.hours, 0));
    return [
      {
        position: 1,
        description: `${subject} (${totalHours} Std.)`,
        quantity: 1,
        unit: 'pauschal',
        unitPrice: totalNet,
        netAmount: totalNet,
        vatRate,
      },
    ];
  }

  return entries.map((entry, index) => ({
    position: index + 1,
    description:
      `${fmtDateShort(entry.entry.startedAt)} — ${entry.entry.description} ` +
      `(${entry.minutes} Min. × ${entry.rate.toFixed(2)} €/Std.)`,
    quantity: 1,
    unit: 'pauschal',
    unitPrice: entry.net,
    netAmount: entry.net,
    vatRate,
  }));
}

interface TimeEntryClaimDb {
  timeEntry: {
    updateMany(args: {
      where: { id: { in: string[] }; invoiceId: null };
      data: { invoiceId: string };
    }): Promise<{ count: number }>;
  };
}

/** Atomarer Claim; false bedeutet, dass ein konkurrierender Lauf gewonnen hat. */
export async function claimTimeEntriesForInvoice(
  db: TimeEntryClaimDb,
  entryIds: string[],
  invoiceId: string,
): Promise<boolean> {
  const claimed = await db.timeEntry.updateMany({
    where: { id: { in: entryIds }, invoiceId: null },
    data: { invoiceId },
  });
  return claimed.count === entryIds.length;
}
