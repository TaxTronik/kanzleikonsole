// =============================================================================
// Steuertermine im Monatsraster — Zähler pro Tag, Art, Periode und Status.
//
// Review-Befund P-20: /staff/tax-deadlines lud für das Monatsraster alle
// Termine des Monats samt Mandant (10.000–20.000 Zeilen), nur um zu zählen.
// Beide Monatsansichten (Steuertermine und Kanzleikalender) aggregieren jetzt
// mit DIESER Abfrage in der Datenbank: eine Zeile je Tag × Art × Periode ×
// Status, in der Größenordnung von 100 Zeilen pro Monat.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { groupTaxDeadlinesByDay, type TaxDeadlineDayGroup } from '@/lib/tax-calendar';

/**
 * `where` enthält Zeitraum und Sichtbarkeits-/Seitenfilter des Aufrufers
 * unverändert. Sortiert wird nach Tag, Art (Enum-Reihenfolge) und Periode, damit
 * die ersten Pillen eines Tages und der Rest „+N weitere" stabil bleiben.
 */
export async function loadTaxDeadlineDayGroupsTx(
  tx: TxClient,
  where: Prisma.TaxDeadlineWhereInput,
): Promise<Map<string, TaxDeadlineDayGroup[]>> {
  const rows = await tx.taxDeadline.groupBy({
    by: ['dueDate', 'kind', 'period', 'status'],
    where,
    orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { period: 'asc' }],
    _count: { _all: true },
  });
  return groupTaxDeadlinesByDay(rows);
}
