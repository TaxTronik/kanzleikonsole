// Formatierung in de-DE (ohne Zeitzonen-Überraschungen: Daten sind UTC-Tage).

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const EUR_GANZ = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const ZAHL = new Intl.NumberFormat('de-DE');

export function fmtEur(n: number | null | undefined): string {
  return n == null ? '—' : EUR.format(n);
}

export function fmtEurGanz(n: number | null | undefined): string {
  return n == null ? '—' : EUR_GANZ.format(n);
}

export function fmtZahl(n: number): string {
  return ZAHL.format(n);
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtDatum(d: Date | null | undefined): string {
  if (!d) return '—';
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

export function fmtDatumKurz(d: Date | null | undefined): string {
  if (!d) return '—';
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.`;
}

/** Zeitstempel in Europe/Berlin. */
export function fmtDatumZeit(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function fmtMonatJahr(seit: string | null | undefined): string {
  if (!seit) return '—';
  const [j, m] = seit.split('-');
  return m && j ? `${m}/${j}` : seit;
}

export function isoDatum(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export function kurzHash(hash: string): string {
  return hash.length > 8 ? `${hash.slice(0, 4)}…${hash.slice(-4)}` : hash;
}

/** „in 3 Tagen", „heute", „seit 6 Tagen". */
export function relativTage(tage: number): string {
  if (tage === 0) return 'heute';
  if (tage === 1) return 'morgen';
  if (tage === -1) return 'seit 1 Tag';
  return tage > 0 ? `in ${tage} Tagen` : `seit ${-tage} Tagen`;
}
