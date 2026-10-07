// =============================================================================
// createWorker() — einheitliche BullMQ-Worker-Konstruktion.
//
// F-05: Vorher hatten 11 von 26 Workern keinen `failed`-Handler und keiner einen
// `error`-Handler. Fehlgeschlagene Läufe tauchten dann nur als Zähler in der
// Ops-Ansicht auf, Verbindungs- und Lock-Fehler des Workers landeten unstrukturiert
// auf console.error. Jeder Worker entsteht jetzt hier und loggt beides
// strukturiert (Queue, Job-ID/-Name, Versuche, Fehler). Job-Daten werden bewusst
// nicht geloggt — sie können personenbezogene Inhalte tragen.
//
// F-06: Jeder Job läuft in einem Log-Kontext (log-context.ts); alle Zeilen, die
// der Processor schreibt, tragen damit Queue und Job-ID.
// =============================================================================

import { Worker, type Job, type Processor, type WorkerOptions } from 'bullmq';
import { runWithJobLogContext } from './log-context';
import { log } from './logger';

function errorFields(err: unknown, withStack: boolean): Record<string, unknown> {
  if (!(err instanceof Error)) return { err: String(err) };
  return withStack
    ? { err: err.message, errName: err.name, stack: err.stack }
    : { err: err.message, errName: err.name };
}

/**
 * BullMQ emits `failed` after every failed attempt; `attemptsMade` already counts
 * it. `finishedOn` is only set when the job will not be retried (last attempt,
 * UnrecoverableError, discarded), so a pending retry is a warning, the final
 * failure an error.
 */
export function logJobFailure(queue: string, job: Job | undefined, err: unknown): void {
  const attempts = job?.opts?.attempts ?? 1;
  const attemptsMade = job?.attemptsMade ?? null;
  const retryPending = job != null && job.finishedOn == null && (job.attemptsMade ?? 0) < attempts;
  const fields = {
    queue,
    jobId: job?.id ?? null,
    jobName: job?.name ?? null,
    attemptsMade,
    attempts,
    retryPending,
  };
  if (retryPending) {
    log.warn({ ...fields, ...errorFields(err, false) }, 'worker: job failed, retry pending');
  } else {
    log.error({ ...fields, ...errorFields(err, true) }, 'worker: job failed');
  }
}

const REDIS_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const CONNECTION_ERROR_LOG_INTERVAL_MS = 60_000;
const connectionErrorLog = new Map<string, { loggedAt: number; suppressed: number }>();

function connectionErrorKey(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && REDIS_CONNECTION_ERROR_CODES.has(code)) return code;
  if (err.message === 'Connection is closed.' || err.message.includes('ECONNREFUSED')) {
    return err.message;
  }
  return null;
}

/**
 * Worker-/Verbindungsfehler außerhalb eines Jobs (Redis, Lock-Verlängerung, ...).
 * Alle Worker teilen sich Redis: ein Ausfall meldet jeder Worker bei jedem
 * Reconnect-Versuch. Verbindungsfehler werden deshalb prozessweit höchstens
 * einmal pro Minute und Fehlercode geloggt (mit Anzahl unterdrückter Meldungen);
 * alle anderen Fehler immer.
 */
export function logWorkerError(queue: string, err: unknown, now: number = Date.now()): void {
  const key = connectionErrorKey(err);
  if (key == null) {
    log.error({ queue, ...errorFields(err, true) }, 'worker: error');
    return;
  }
  const previous = connectionErrorLog.get(key);
  if (previous && now - previous.loggedAt < CONNECTION_ERROR_LOG_INTERVAL_MS) {
    previous.suppressed += 1;
    return;
  }
  connectionErrorLog.set(key, { loggedAt: now, suppressed: 0 });
  log.error(
    { queue, ...errorFields(err, false), suppressedSinceLastLog: previous?.suppressed ?? 0 },
    'worker: redis connection error',
  );
}

/** F-06: Processor im Log-Kontext seines Jobs (Queue + Job-ID) ausführen. */
export function withJobLogContext<DataType, ResultType, NameType extends string>(
  queueName: string,
  processor: Processor<DataType, ResultType, NameType>,
): Processor<DataType, ResultType, NameType> {
  return (job, token, signal) =>
    runWithJobLogContext({ queue: queueName, jobId: job.id ?? null }, () =>
      processor(job, token, signal),
    );
}

/**
 * Drop-in für `new Worker(...)`: gleiche Argumente, plus garantierte
 * `failed`- und `error`-Handler und Log-Kontext je Job.
 */
export function createWorker<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string,
>(
  queueName: string,
  processor: Processor<DataType, ResultType, NameType>,
  opts: WorkerOptions,
): Worker<DataType, ResultType, NameType> {
  const worker = new Worker<DataType, ResultType, NameType>(
    queueName,
    withJobLogContext(queueName, processor),
    opts,
  );
  worker.on('failed', (job, err) => logJobFailure(queueName, job as Job | undefined, err));
  worker.on('error', (err) => logWorkerError(queueName, err));
  return worker;
}
