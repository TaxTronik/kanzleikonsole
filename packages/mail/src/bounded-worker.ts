import { memoryUsage } from 'node:process';
import { Worker } from 'node:worker_threads';

/**
 * Grenzen für das Parsen nicht vertrauenswürdiger Dateien in einem Worker-Thread.
 * V8-Heap-Limits decken ArrayBuffer nicht ab; deshalb beobachtet der Aufrufer
 * zusätzlich das RSS-Wachstum des Prozesses. Der RSS-Wächter ist unter
 * paralleler Last konservativ und keine harte OS-Grenze.
 */
export interface BoundedWorkerLimits {
  timeoutMs: number;
  rssBudgetBytes: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
}

export type BoundedWorkerFailure = 'spawn' | 'timeout' | 'memory' | 'error' | 'exit';

export type BoundedWorkerResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BoundedWorkerFailure };

/**
 * Führt ein festes Programm (`program`, nie die Eingabedaten) in einem eigenen
 * Thread aus und liefert dessen erste Nachricht. Der Thread wird nach Ergebnis,
 * Fehler, Frist oder Speicherüberschreitung beendet. Parser-Diagnosen können
 * nicht vertrauenswürdige Inhalte enthalten und werden nie weitergereicht.
 */
export async function runBoundedWorker<T>(
  program: string,
  workerData: unknown,
  limits: BoundedWorkerLimits,
): Promise<BoundedWorkerResult<T>> {
  const baselineRss = memoryUsage.rss();
  let worker: Worker;
  try {
    worker = new Worker(program, {
      eval: true,
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
        stackSizeMb: limits.stackSizeMb,
      },
      stdout: true,
      stderr: true,
    });
  } catch {
    return { ok: false, reason: 'spawn' };
  }
  worker.stdout?.resume();
  worker.stderr?.resume();
  return new Promise<BoundedWorkerResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: BoundedWorkerResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(memoryWatch);
      void worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const deadline = setTimeout(() => finish({ ok: false, reason: 'timeout' }), limits.timeoutMs);
    const memoryWatch = setInterval(() => {
      if (memoryUsage.rss() - baselineRss > limits.rssBudgetBytes) {
        finish({ ok: false, reason: 'memory' });
      }
    }, 25);
    worker.once('message', (value: T) => finish({ ok: true, value }));
    worker.once('error', () => finish({ ok: false, reason: 'error' }));
    worker.once('exit', () => finish({ ok: false, reason: 'exit' }));
  });
}
