export interface DashboardMutationQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
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
