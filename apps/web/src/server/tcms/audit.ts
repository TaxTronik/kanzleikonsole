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

/** Wert des Dienstes → fester Text der kanzleikonsole. */
const AUDIT_BRUCH_TEXTE: Readonly<Record<string, string>> = Object.freeze({
  'Reihenfolge der Einträge passt nicht': 'Die Reihenfolge der Einträge passt nicht.',
  'Lücke in den Positionen': 'In der Nummerierung der Einträge fehlt ein Eintrag.',
  'Unbekannte Kettenversion': 'Der Eintrag hat ein unbekanntes Format.',
  'Eintrag gehört zu einem anderen Tenant': 'Der Eintrag gehört zu einer anderen Kanzlei.',
  'Vorgänger-Hash passt nicht': 'Die Verkettung mit dem vorigen Eintrag passt nicht.',
  'Inhalt wurde verändert': 'Der Inhalt des Eintrags wurde verändert.',
});

/** Rückfall ohne bekannten Grund. */
export const AUDIT_BRUCH_RUECKFALL = 'Prüfung fehlgeschlagen.';

/** Fester Text zum Grund eines Kettenbruchs (eigene Eigenschaften, nie Prototyp-Schlüssel). */
export function auditBruchText(grund: string | null | undefined): string {
  return typeof grund === 'string' && Object.hasOwn(AUDIT_BRUCH_TEXTE, grund)
    ? AUDIT_BRUCH_TEXTE[grund]!
    : AUDIT_BRUCH_RUECKFALL;
}
