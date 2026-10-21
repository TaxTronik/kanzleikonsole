// =============================================================================
// Grund einer gebrochenen Hashkette des Tax-CMS (Audit-Prüfung, Bereich D;
// Angriffsdurchlauf RT3). Der Dienst meldet `grund` als Text (Vertrag:
// `AuditPruefenAntwortSchema.grund`, höchstens 200 Zeichen). Die
// kanzleikonsole zeigt nie den Text des Dienstes (Leitfaden Abschnitt 6),
// sondern ordnet den gelieferten Wert über eine feste Tabelle einem eigenen
// Text zu; alles andere – auch ein fehlender Grund – wird „Prüfung
// fehlgeschlagen“. Die Werte sind die Gründe der Kettenprüfung des Dienstes
// (`pruefeKette` in packages/domain/src/audit.ts des TCMS-Repos; die Datei
// wird bewusst nicht vendort, die Hashkette rechnet nur der Dienst). Ein
// neuer Grund im Dienst erscheint bis zur Ergänzung hier als Rückfall.
// =============================================================================

import type { AkteurArt } from '@taxtronik/tcms-contract';

/** Wert des Dienstes → fester Text der kanzleikonsole. */
const AUDIT_BRUCH_TEXTE: Readonly<Record<string, string>> = Object.freeze({
  'Reihenfolge der Einträge passt nicht': 'Die Reihenfolge der Einträge passt nicht.',
  'Lücke in den Positionen': 'In der Nummerierung der Einträge fehlt ein Eintrag.',
  'Unbekannte Kettenversion': 'Der Eintrag hat ein unbekanntes Format.',
  'Eintrag gehört zu einem anderen Tenant': 'Der Eintrag gehört zu einer anderen Kanzlei.',
  'Vorgänger-Hash passt nicht': 'Die Verkettung mit dem vorigen Eintrag passt nicht.',
  'Inhalt wurde verändert': 'Der Inhalt des Eintrags wurde verändert.',
});

/**
 * Hinweis aus RT3B: Die Prüfung setzt eine abgebrochene Kette bis zu 50-mal
 * fort, je Aufruf mit bis zu 10 s (Zeitlimit des Clients) – zusammen mehr als
 * das Zeitlimit des Proxys für Seiten und Server-Aktionen (nginx 60 s,
 * infra/nginx). Gesamtbudget der Prüfung: Ein weiterer Aufruf beginnt nur,
 * wenn er samt seinem Zeitlimit noch hineinpasst; danach meldet die Aktion
 * „nicht abgeschlossen“ und die Person startet erneut.
 */
export const AUDIT_PRUEFUNG_BUDGET_MS = 50_000;
/** Zeitlimit eines Dienstaufrufs (Standard des Clients, packages/tcms-client). */
export const AUDIT_AUFRUF_ZEITLIMIT_MS = 10_000;

/** Rückfall ohne bekannten Grund. */
export const AUDIT_BRUCH_RUECKFALL = 'Prüfung fehlgeschlagen.';

/** Fester Text zum Grund eines Kettenbruchs (eigene Eigenschaften, nie Prototyp-Schlüssel). */
export function auditBruchText(grund: string | null | undefined): string {
  return typeof grund === 'string' && Object.hasOwn(AUDIT_BRUCH_TEXTE, grund)
    ? AUDIT_BRUCH_TEXTE[grund]!
    : AUDIT_BRUCH_RUECKFALL;
}

// -----------------------------------------------------------------------------
// Maskierte Einträge (TCMS s11, Vendoring bfdfdd2; kk-tcms-s11 Punkt 7). Der
// Dienst liefert Einträge zu vertraulichen Feststellungen und ihren Maßnahmen
// an Nicht-Beteiligte als `maskiert: true` – nur Position, Zeit, Ereignisart,
// Objekt, Programm, Mandant, Akteursart und „vertraulich“, ohne Namen,
// Personen-ID, Detail und Hashes; ab der ersten maskierten Position auch für
// alle späteren Einträge keine Hashes (`null`). Die mandantenübergreifende
// Audit-Seite sendet keinen Mandantenbezug und zeigt deshalb maskiert an; die
// Oberfläche ergänzt nur feste Texte und nichts aus anderen Quellen.
// -----------------------------------------------------------------------------

/** Akteursart eines maskierten Eintrags → fester Text (`null`: ohne Akteur). */
export const AUDIT_AKTEUR_ART_TEXTE: Readonly<Record<AkteurArt, string>> = Object.freeze({
  KANZLEI: 'Kanzleiperson',
  MANDANT: 'Mandantenkontakt',
  SYSTEM: 'System',
});

export function auditAkteurArtText(art: AkteurArt | null): string {
  return art === null ? 'ohne Akteur' : AUDIT_AKTEUR_ART_TEXTE[art];
}

/** Anstelle eines Hashes, den der Dienst nicht mitteilt. */
export const AUDIT_HASH_VERBORGEN = 'nicht angezeigt';

/** Hinweis, sobald die Seite maskierte Einträge oder verborgene Hashes enthält. */
export const AUDIT_VERTRAULICH_HINWEIS =
  'Einträge zu vertraulichen Feststellungen und ihren Maßnahmen erscheinen ohne Person und Inhalt. Ab dem ersten solchen Eintrag zeigt die Liste keine Hashes; die Integrität der ganzen Kette prüft „Hashkette prüfen“.';
