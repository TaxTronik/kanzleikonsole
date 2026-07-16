// =============================================================================
// Datums-Helfer für zeitzonenbewusste Tagesgrenzen im Worker.
//
// `@db.Date`-Spalten (dueDate, validUntil, …) sind als UTC-Mitternacht des
// Kalendertags gespeichert. Vergleiche gegen „heute" MÜSSEN denselben
// Berlin-Kalendertag als UTC-Mitternacht bilden — sonst kippt die Grenze je
// nach Serverzeitzone/UTC-Offset um bis zu zwei Stunden in den Vortag.
// =============================================================================

export { berlinTodayUtcMidnight } from '@taxtronik/tax';

/** Ganze Kalendertage zwischen zwei UTC-Mitternachten (b − a), exakt gerundet. */
export function wholeDaysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}
