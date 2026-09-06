/** GWG-SCREENING-001: candidate search only; never a sanctions or PEP decision. */
export const SCREENING_ALGORITHM = 'eu-alias-dice-v1';
export interface SanctionEntry {
  id: string;
  euReference: string;
  type: string;
  names: Array<{ name: string; strong: boolean }>;
  birthDates: Array<{ date: string; year: string; circa: boolean }>;
  countries: string[];
  regulations: Array<{ title: string; url: string }>;
}
export interface ScreeningSubject {
  name: string;
  birthDate?: string;
  role: string;
}
export function normalizeScreeningName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('und')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 6) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let same = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2),
      n = grams.get(g) ?? 0;
    if (n) {
      same++;
      grams.set(g, n - 1);
    }
  }
  return (2 * same) / (a.length + b.length - 2);
}
export function validateScreeningSubject(subject: ScreeningSubject): ScreeningSubject {
  if (
    typeof subject.name !== 'string' ||
    subject.name.trim().length < 2 ||
    subject.name.length > 250 ||
    normalizeScreeningName(subject.name).length < 2
  )
    throw new Error('Name muss 2–250 Zeichen enthalten.');
  if (typeof subject.role !== 'string' || !subject.role.trim() || subject.role.length > 160)
    throw new Error('Rolle / Bezug zum Mandat fehlt.');
  if (
    subject.birthDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(subject.birthDate) ||
      !Number.isFinite(Date.parse(subject.birthDate)) ||
      new Date(subject.birthDate).toISOString().slice(0, 10) !== subject.birthDate)
  )
    throw new Error('Geburtsdatum ist ungültig.');
  return {
    name: subject.name.trim(),
    role: subject.role.trim(),
    ...(subject.birthDate ? { birthDate: subject.birthDate } : {}),
  };
}
export function screenEu(subjectInput: ScreeningSubject, entries: SanctionEntry[]) {
  const subject = validateScreeningSubject(subjectInput),
    name = normalizeScreeningName(subject.name);
  const sorted = name.split(' ').sort().join(' ');
  const candidates = entries
    .flatMap((entry) => {
      let score = 0,
        alias = '',
        strong = false;
      for (const item of entry.names) {
        const n = normalizeScreeningName(item.name),
          s = Math.max(dice(name, n), dice(sorted, n.split(' ').sort().join(' ')));
        if (s > score) {
          score = s;
          alias = item.name;
          strong = item.strong;
        }
      }
      if (score < 0.82) return [];
      const birthMatch =
        !subject.birthDate || !entry.birthDates.length
          ? 'UNKNOWN'
          : entry.birthDates.some((d) => d.date === subject.birthDate)
            ? 'EXACT'
            : entry.birthDates.some((d) => d.year === subject.birthDate!.slice(0, 4))
              ? 'YEAR_ONLY'
              : 'CONFLICT';
      return [
        {
          entryId: entry.id,
          euReference: entry.euReference,
          alias,
          strong,
          score: Math.round(score * 1000) / 1000,
          birthMatch,
          type: entry.type,
          countries: entry.countries,
          birthDates: entry.birthDates,
          regulations: entry.regulations,
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId));
  return {
    algorithm: SCREENING_ALGORITHM,
    status: candidates.length ? 'CANDIDATES' : 'NO_NAME_CANDIDATE',
    candidateCount: candidates.length,
    truncated: candidates.length > 100,
    candidates: candidates.slice(0, 100),
    limitations:
      'Nur Namensähnlichkeit zur lokalen EU-Liste. Geburtsdatum widerspricht ggf., schließt Treffer aber nicht aus. Keine vollständige Transliteration, keine Eigentums-/Kontrollprüfung, keine PEP-Daten. Kein Treffer ist keine Freigabe.',
  };
}

export function sourceIsFresh(
  checkedAt: Date | null,
  lastError: string | null,
  now = new Date(),
): boolean {
  return (
    !!checkedAt &&
    !lastError &&
    checkedAt.getTime() <= now.getTime() + 60_000 &&
    now.getTime() - checkedAt.getTime() <= 48 * 60 * 60 * 1000
  );
}
