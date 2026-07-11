import { fmtDateShort, round2 } from '@/lib/fmt';

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

export function validateTimeBillingTax(input: {
  vatRate: number;
  reverseCharge: boolean;
  vatExemptionReason: string | null;
}): string | null {
  if (![0, 7, 19].includes(input.vatRate)) {
    return 'Ungültiger USt-Satz (zulässig: 0 %, 7 %, 19 %).';
  }
  if (input.reverseCharge && input.vatRate !== 0) {
    return 'Reverse-Charge (§ 13b UStG) erfordert 0 % USt.';
  }
  if (input.vatRate === 0 && !input.reverseCharge && !input.vatExemptionReason) {
    return 'Bei 0 % USt ist ein Befreiungsgrund erforderlich (z. B. § 19 oder § 4 UStG).';
  }
  return null;
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
