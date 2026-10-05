// =============================================================================
// Zeitgesteuertes Fortsetzen pausierter Workflow-Instanzen — Web-Seite.
//
// F-13: Das Fortsetzen selbst schreibt nicht mehr das Rendern der Workflow-
// Seite, sondern der Worker-Job workflow-auto-resume (alle 5 min, je Instanz
// eine kurze Transaktion; CAS in @taxtronik/db/workflow-lifecycle). Vorher
// blieben fällige Instanzen in Übersicht, Dashboard und Arbeitskorb pausiert,
// bis jemand den Workflow-Tab eines Mandanten öffnete, und dieser Seitenaufruf
// schrieb unter dem Audit-Lock des Tenants.
//
// Hier bleibt nur die lesende Einordnung für die Anzeige: Eine Instanz, deren
// Pausentermin erreicht ist, wird bis zum nächsten Lauf als „Pause abgelaufen"
// gezeigt statt mit einem vergangenen „pausiert bis".
// =============================================================================

/** True, wenn eine pausierte Instanz ihren Pausentermin bereits erreicht hat. */
export function isPauseElapsed(
  instance: { status: string; pausedUntil: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    instance.status === 'PAUSED' &&
    instance.pausedUntil !== null &&
    instance.pausedUntil.getTime() <= now.getTime()
  );
}
