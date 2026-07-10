// Fristberechnung für DSGVO-Betroffenenanträge (Art. 12 Abs. 3 DSGVO: 1 Monat).
//
// Bewusst KEINE Werktagsverschiebung: Art. 3 Abs. 4 VO (EWG, Euratom) 1182/71
// verlängert eine auf Samstag/Sonntag/Feiertag fallende Frist zwar auf den
// nächsten Werktag — das zöge das angezeigte Fristende aber nach HINTEN. Bei
// einer Bearbeiterpflicht (die Kanzlei muss fristgerecht antworten) ist das die
// gefährliche Richtung. Das kalendarische Monatsende ist der konservative,
// nie zu späte Anzeigewert.

/**
 * Addiert `months` Kalendermonate monatsende-sicher (§ 188 Abs. 3 BGB):
 * fehlt der Ausgangstag im Zielmonat (z. B. 31.01. → 31.02.), endet die Frist
 * am LETZTEN Tag des Zielmonats (→ 28./29.02.).
 *
 * Native `Date.setMonth()` rollt beim Überlauf stattdessen in den Folgemonat
 * (31.01. → 03.03.) und täuscht so mehrere Tage zu viel Frist vor. Uhrzeit und
 * lokale Zeitzone des Ausgangsdatums bleiben erhalten.
 */
export function addCalendarMonths(from: Date, months: number): Date {
  const day = from.getDate();
  const target = new Date(from);
  // Tag zuerst auf den 1. setzen, dann Monat verschieben → kein Überlauf.
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  // Letzter Tag des Zielmonats: Tag 0 des Folgemonats.
  const lastDayOfTargetMonth = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  target.setDate(Math.min(day, lastDayOfTargetMonth));
  return target;
}

/**
 * Antwortfrist eines DSGVO-Betroffenenantrags: ein Kalendermonat ab `from`.
 * `from` sollte der Eingangstag des Antrags sein.
 */
export function dsgvoResponseDeadline(from: Date): Date {
  return addCalendarMonths(from, 1);
}
