// =============================================================================
// Zeitbudget für Wartungsjobs mit Nachlauf (P-17).
//
// audit-rotate und storage-orphan-cleanup arbeiteten je Lauf eine feste Menge
// ab (5.000 Audit-Einträge pro Woche und Tenant, 100 Storage-Kandidaten je
// 6-Stunden-Lauf) und fielen bei größerem Anfall Lauf für Lauf weiter zurück.
// Jetzt arbeiten sie in einer Schleife, bis nichts mehr fällig ist oder das
// Budget verbraucht ist, und melden den verbleibenden Rückstand im Job-Ergebnis
// (`backlog`, gelesen von der Admin-Seite System → Jobs).
//
// Fährt der Worker herunter (Worker.close setzt `closing`), endet die Schleife
// nach dem laufenden Schritt. Sonst wartete das Shutdown bis zu zehn Minuten
// und der Container würde nach der stop_grace_period (180 s) hart beendet.
// =============================================================================

export const MAINTENANCE_RUN_BUDGET_MS = 10 * 60_000;

export interface RunBudget {
  /** true, sobald das Zeitbudget verbraucht ist oder der Lauf enden soll. */
  exhausted(): boolean;
}

export function startRunBudget(
  options: { budgetMs?: number; clock?: () => number; stop?: () => boolean } = {},
): RunBudget {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? MAINTENANCE_RUN_BUDGET_MS);
  return { exhausted: () => clock() >= deadline || (options.stop?.() ?? false) };
}

/** BullMQ setzt `closing`, sobald Worker.close() aufgerufen wurde. */
export function isWorkerClosing(worker: { closing?: Promise<void> | undefined }): boolean {
  return worker.closing !== undefined;
}
