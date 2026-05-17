// =============================================================================
// Format-Helper, die wir mehrfach brauchen
// =============================================================================

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtEUR(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);
}

export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

export function fmtDateShort(d: Date): string {
  return new Intl.DateTimeFormat('de-DE').format(d);
}

export function fmtDateTimeShort(d: Date): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}
