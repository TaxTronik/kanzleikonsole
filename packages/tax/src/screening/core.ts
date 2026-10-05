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
/** Bigramm-Multimenge eines normalisierten Namens (UTF-16-Codeeinheiten wie zuvor). */
function bigramCounts(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < value.length - 1; i++) {
    const g = value.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/**
 * Vorbereiteter Name: normalisiert, mit sortierten Tokens und den Bigramm-
 * Multimengen beider Fassungen. Für die EU-Aliasse einmal je Lauf berechnet
 * (P-16); vorher entstanden Normalisierung und Bigramme je Prüfsubjekt und
 * Vergleich neu. Beim Einzelabgleich mit roher Liste entstehen die Bigramme
 * erst, wenn ein Alias die Längenschranke passiert.
 */
interface PreparedName {
  normalized: string;
  sorted: string;
  grams?: Map<string, number>;
  sortedGrams?: Map<string, number>;
}

function prepareName(name: string, withGrams: boolean): PreparedName {
  const normalized = normalizeScreeningName(name);
  const prepared: PreparedName = { normalized, sorted: normalized.split(' ').sort().join(' ') };
  if (withGrams) {
    gramsOf(prepared);
    sortedGramsOf(prepared);
  }
  return prepared;
}

function gramsOf(name: PreparedName): Map<string, number> {
  return (name.grams ??= bigramCounts(name.normalized));
}

function sortedGramsOf(name: PreparedName): Map<string, number> {
  return (name.sortedGrams ??=
    name.sorted === name.normalized ? gramsOf(name) : bigramCounts(name.sorted));
}

/**
 * Sørensen-Dice über Bigramme. Die Schnittmenge der Multimengen ist dieselbe
 * Zahl, die der frühere Verbrauchsalgorithmus (jedes Bigramm von b höchstens so
 * oft wie in a) gezählt hat.
 */
function dice(a: string, aGrams: Map<string, number>, b: string, bGrams: Map<string, number>) {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 6) return 0;
  const [small, large] = aGrams.size <= bGrams.size ? [aGrams, bGrams] : [bGrams, aGrams];
  let same = 0;
  for (const [gram, count] of small) {
    const other = large.get(gram);
    if (other) same += Math.min(count, other);
  }
  return (2 * same) / (a.length + b.length - 2);
}

const CANDIDATE_THRESHOLD = 0.82;

/**
 * Obere Schranke des Dice-Werts allein aus den Längen (gleiche Länge der
 * sortierten Fassung). Liegt sie unter der Kandidatenschwelle, kann der Alias
 * weder Kandidat werden noch einen Kandidaten-Score bestimmen.
 */
function cannotReachThreshold(subjectLength: number, aliasLength: number): boolean {
  if (subjectLength === aliasLength) return false;
  const shorter = Math.min(subjectLength, aliasLength);
  if (shorter < 6) return true;
  return (2 * (shorter - 1)) / (subjectLength + aliasLength - 2) < CANDIDATE_THRESHOLD;
}

interface PreparedEntry {
  entry: SanctionEntry;
  aliases: Array<{ name: string; strong: boolean; prepared: PreparedName }>;
}

/** Einmal je Lauf vorbereitete EU-Liste für viele Prüfsubjekte (P-16). */
export interface PreparedEuList {
  readonly kind: 'prepared-eu-list';
  readonly entries: readonly PreparedEntry[];
}

export function prepareEuList(entries: readonly SanctionEntry[]): PreparedEuList {
  return {
    kind: 'prepared-eu-list',
    entries: entries.map((entry) => ({
      entry,
      aliases: entry.names.map((item) => ({
        name: item.name,
        strong: item.strong,
        prepared: prepareName(item.name, true),
      })),
    })),
  };
}

/** Einzelabgleich: nur normalisieren, Bigramme bei Bedarf (siehe gramsOf). */
function prepareEuListLazily(entries: readonly SanctionEntry[]): PreparedEuList {
  return {
    kind: 'prepared-eu-list',
    entries: entries.map((entry) => ({
      entry,
      aliases: entry.names.map((item) => ({
        name: item.name,
        strong: item.strong,
        prepared: prepareName(item.name, false),
      })),
    })),
  };
}

export function isPreparedEuList(
  list: readonly SanctionEntry[] | PreparedEuList,
): list is PreparedEuList {
  return !Array.isArray(list) && (list as PreparedEuList).kind === 'prepared-eu-list';
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
/**
 * Kandidatensuche eines Prüfsubjekts gegen die EU-Liste. Akzeptiert die Liste
 * roh (Einzelabgleich) oder einmal vorbereitet (prepareEuList, Folgeläufe);
 * Ergebnis und Reihenfolge sind in beiden Fällen identisch.
 */
export function screenEu(
  subjectInput: ScreeningSubject,
  list: readonly SanctionEntry[] | PreparedEuList,
) {
  const subject = validateScreeningSubject(subjectInput),
    probe = prepareName(subject.name, true);
  const prepared = isPreparedEuList(list) ? list : prepareEuListLazily(list);
  const candidates = prepared.entries
    .flatMap(({ entry, aliases }) => {
      let score = 0,
        alias = '',
        strong = false;
      for (const item of aliases) {
        const n = item.prepared;
        if (cannotReachThreshold(probe.normalized.length, n.normalized.length)) continue;
        const s = Math.max(
          dice(probe.normalized, gramsOf(probe), n.normalized, gramsOf(n)),
          dice(probe.sorted, sortedGramsOf(probe), n.sorted, sortedGramsOf(n)),
        );
        if (s > score) {
          score = s;
          alias = item.name;
          strong = item.strong;
        }
      }
      if (score < CANDIDATE_THRESHOLD) return [];
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
