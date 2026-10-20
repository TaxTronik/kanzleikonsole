// =============================================================================
// Idempotenzfenster der Portal-Meldung (kk-tcms-s10nach, TCMS s10): Das
// Tax-CMS nimmt je Person, Mandant und Schlüssel innerhalb von 24 h (echte
// Zeit ab der ersten Annahme) genau eine Meldung an; danach ist der Schlüssel
// verbraucht und eine Wiederholung legte ein zweites Ereignis an. Web (Wieder-
// holung) und Worker (Bereinigung) nutzen dieselben Grenzen.
// =============================================================================

/** Wiederholung höchstens so lange nach dem ersten Senden: 24 h minus 1 h Uhrenabstand. */
export const MELDUNG_WIEDERHOLUNG_FENSTER_MS = 23 * 3_600_000;

/** Nie gesendete Vorgänge (Abbruch vor dem Senden) räumt der Worker danach auf. */
export const MELDUNG_UNGESENDET_AUFBEWAHRUNG_MS = 24 * 3_600_000;
