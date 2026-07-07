// =============================================================================
// Datums-Helfer für zeitzonenbewusste Tagesgrenzen im Worker.
//
// `@db.Date`-Spalten (dueDate, validUntil, …) sind als UTC-Mitternacht des
// Kalendertags gespeichert. Vergleiche gegen „heute" MÜSSEN denselben
// Berlin-Kalendertag als UTC-Mitternacht bilden — sonst kippt die Grenze je
// nach Serverzeitzone/UTC-Offset um bis zu zwei Stunden in den Vortag.
// =============================================================================

/** UTC-Mitternacht des HEUTIGEN Kalendertags in Europe/Berlin. */
export function berlinTodayUtcMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Ganze Kalendertage zwischen zwei UTC-Mitternachten (b − a), exakt gerundet. */
export function wholeDaysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}
