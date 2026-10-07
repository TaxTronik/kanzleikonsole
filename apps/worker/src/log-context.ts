// =============================================================================
// Job-Kontext für den Worker-Logger (Review-Befund F-06).
//
// Pendant zur Request-ID der Web-App: Jede Logzeile, die während eines Jobs
// entsteht, trägt Queue-Name und Job-ID (logger.ts, pino-`mixin`). Der Kontext
// liegt in einem AsyncLocalStorage, überlebt also jedes `await` und Timer des
// Jobs. createWorker() (worker-factory.ts) setzt ihn für jeden Job. Job-IDs
// sind BullMQ-Zähler oder interne Schlüssel aus Queue-Präfix und UUIDs, keine
// Personendaten; Job-Daten gelangen nicht in den Kontext.
// =============================================================================

import { AsyncLocalStorage } from 'node:async_hooks';

export interface JobLogContext {
  queue: string;
  jobId: string | null;
}

const jobLogContext = new AsyncLocalStorage<JobLogContext>();

/** Führt `fn` mit Queue und Job-ID als Kontext aller darin entstehenden Logzeilen aus. */
export function runWithJobLogContext<T>(context: JobLogContext, fn: () => T): T {
  return jobLogContext.run(context, fn);
}

/** Kontext des laufenden Jobs oder `undefined` außerhalb eines Jobs. */
export function currentJobLogContext(): JobLogContext | undefined {
  return jobLogContext.getStore();
}
