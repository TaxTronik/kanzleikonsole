export interface DashboardMutationQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
}

/**
 * Begrenzt den bei Ausführung gelesenen Live-Stand auf die Widgets, die zum
 * Zeitpunkt dieser Queue-Mutation bereits existierten. So übernimmt ein
 * früher Add-Snapshot nie Widgets aus späteren optimistischen Klicks, behält
 * für seine eigenen Widgets aber die inzwischen aktuellsten Positionen.
 */
export function snapshotForQueuedDashboardAdd<T extends { id: string }>(
  current: readonly T[],
  includedIds: ReadonlySet<string>,
): T[] {
  return current.filter((entry) => includedIds.has(entry.id));
}

/** Serialisiert vollstaendige Layout-Snapshots in derselben Reihenfolge wie die UI-Aktionen. */
export function createDashboardMutationQueue(): DashboardMutationQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(task) {
      const run = tail.then(task, task);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
