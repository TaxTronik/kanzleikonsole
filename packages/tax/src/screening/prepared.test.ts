// Fachkatalog: GWG-SCREENING-001
// =============================================================================
// P-16: Die einmal je Lauf vorbereitete EU-Liste (prepareEuList) liefert für
// jedes Prüfsubjekt exakt dasselbe Ergebnis wie der bisherige Abgleich, der je
// Subjekt alle Aliasse normalisierte und je Vergleich Bigramme neu baute.
// `legacyScreenEu` ist eine wörtliche Kopie dieses Algorithmus (Stand vor P-16)
// und dient nur als Referenz. Die Fixture-Liste ist deterministisch erzeugt:
// Diakritika, Satzzeichen, vertauschte Tokens, Tippfehler, kurze Namen,
// doppelte Aliasse und Geburtsdaten.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  SCREENING_ALGORITHM,
  normalizeScreeningName,
  prepareEuList,
  screenEu,
  validateScreeningSubject,
  type SanctionEntry,
  type ScreeningSubject,
} from './core';

// --- Referenz: Algorithmus vor P-16 (unverändert übernommen) ----------------
function legacyDice(a: string, b: string): number {
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
function legacyScreenEu(subjectInput: ScreeningSubject, entries: SanctionEntry[]) {
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
          s = Math.max(legacyDice(name, n), legacyDice(sorted, n.split(' ').sort().join(' ')));
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

// --- Deterministische Fixture-Liste -----------------------------------------
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FIRST = ['José', 'Müller', 'Anna', 'Łukasz', 'Ömer', 'Jean-Luc', 'Li', 'Zoë', 'Søren', 'Ali'];
const LAST = ['Muller', 'Schröder', 'Al-Hassan', 'Nguyễn', 'Dubois', 'Ivanov', 'Ng', 'García'];
const ORGS = ['Trading', 'Holding', 'Shipping', 'Bank', 'Group', 'Ltd.', 'GmbH & Co. KG'];

type Rnd = () => number;

function picker(rnd: Rnd) {
  return <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
}

function typo(value: string, rnd: Rnd): string {
  if (value.length < 3) return value;
  const i = 1 + Math.floor(rnd() * (value.length - 2));
  return value.slice(0, i) + String.fromCharCode(97 + Math.floor(rnd() * 26)) + value.slice(i + 1);
}

function aliasVariant(base: string, rnd: Rnd): string {
  const pick = picker(rnd);
  const variant = rnd();
  if (variant < 0.25) return base.split(' ').reverse().join(', ');
  if (variant < 0.5) return typo(base, rnd);
  if (variant < 0.65) return base.toUpperCase().replace(/ /g, '  ');
  if (variant < 0.8) return pick(LAST);
  return `${base} (${pick(FIRST)})`;
}

function fixtureEntry(i: number, rnd: Rnd): SanctionEntry {
  const pick = picker(rnd);
  const company = rnd() < 0.3;
  const base = company
    ? `${pick(LAST)} ${pick(ORGS)} ${pick(ORGS)}`
    : `${pick(FIRST)} ${rnd() < 0.3 ? pick(FIRST) + ' ' : ''}${pick(LAST)}`;
  const names = [{ name: base, strong: true }];
  for (let a = Math.floor(rnd() * 4); a > 0; a--) {
    const name = aliasVariant(base, rnd);
    names.push({ name, strong: rnd() < 0.5 });
  }
  const year = String(1940 + Math.floor(rnd() * 60));
  const euReference = `EU.${i}.${Math.floor(rnd() * 90)}`;
  const birthDates =
    company || rnd() < 0.3 ? [] : [{ date: `${year}-03-0${1 + (i % 9)}`, year, circa: false }];
  const countries = rnd() < 0.5 ? ['RU'] : [];
  return {
    id: String(1000 + i),
    euReference,
    type: company ? 'enterprise' : 'person',
    names,
    birthDates,
    countries,
    regulations: [{ title: '2014/269', url: 'https://eur-lex.europa.eu/' }],
  };
}

function subjectName(alias: string, i: number, rnd: Rnd): string {
  const pick = picker(rnd);
  const mode = rnd();
  if (mode < 0.2) return alias;
  if (mode < 0.4) return alias.split(/[ ,]+/).reverse().join(' ');
  if (mode < 0.6) return typo(alias, rnd);
  if (mode < 0.7) return pick(LAST);
  if (mode < 0.8) return `${pick(FIRST)} ${pick(LAST)}`;
  return `Unrelated Sample ${pick(ORGS)} ${i}`;
}

function subjectBirth(entry: SanctionEntry, rnd: Rnd): { birthDate?: string } {
  const birth = entry.birthDates[0];
  if (birth && rnd() < 0.5) return { birthDate: rnd() < 0.5 ? birth.date : `${birth.year}-12-24` };
  return rnd() < 0.2 ? { birthDate: '1999-01-01' } : {};
}

function fixture(): { entries: SanctionEntry[]; subjects: ScreeningSubject[] } {
  const rnd = random(20261005);
  const pick = picker(rnd);
  const entries: SanctionEntry[] = [];
  for (let i = 0; i < 400; i++) entries.push(fixtureEntry(i, rnd));
  const subjects: ScreeningSubject[] = [];
  for (let i = 0; i < 300; i++) {
    const entry = pick(entries);
    const name = subjectName(pick(entry.names).name, i, rnd);
    subjects.push({
      name: name.trim().length >= 2 ? name : `${name} xx`,
      role: 'Mandant',
      ...subjectBirth(entry, rnd),
    });
  }
  // 101 Treffer für denselben Namen: Kürzung und Reihenfolge der Gleichstände.
  for (let i = 0; i < 101; i++) {
    entries.push({
      id: `dup-${String(i).padStart(3, '0')}`,
      euReference: 'EU.DUP',
      type: 'person',
      names: [{ name: 'Jose Muller', strong: i % 2 === 0 }],
      birthDates: [],
      countries: [],
      regulations: [],
    });
  }
  subjects.push({ name: 'Muller, José', role: 'Vertretung' }, { name: 'Li Ng', role: 'Mandant' });
  return { entries, subjects };
}

describe('P-16: vorbereitete EU-Liste', () => {
  const { entries, subjects } = fixture();
  const prepared = prepareEuList(entries);

  it('liefert für jedes Fixture-Subjekt exakt das bisherige Ergebnis', () => {
    let withCandidates = 0;
    for (const subject of subjects) {
      const expected = legacyScreenEu(subject, entries);
      expect(screenEu(subject, prepared)).toEqual(expected);
      if (expected.candidateCount > 0) withCandidates += 1;
    }
    // Die Fixture deckt Treffer und Nichttreffer in nennenswerter Zahl ab.
    expect(withCandidates).toBeGreaterThan(100);
    expect(subjects.length - withCandidates).toBeGreaterThan(30);
  });

  it('nimmt für den Einzelabgleich weiterhin die rohe Liste an', () => {
    for (const subject of subjects.slice(0, 40)) {
      expect(screenEu(subject, entries)).toEqual(screenEu(subject, prepared));
    }
    const truncated = screenEu({ name: 'Jose Muller', role: 'Mandant' }, prepared);
    expect(truncated).toEqual(legacyScreenEu({ name: 'Jose Muller', role: 'Mandant' }, entries));
    expect(truncated.truncated).toBe(true);
  });
});
