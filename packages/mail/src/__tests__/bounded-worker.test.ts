import { describe, expect, it } from 'vitest';
import { runBoundedWorker, type BoundedWorkerLimits } from '../bounded-worker';

// Antwortet sofort; nur die Grenzen entscheiden über das Ergebnis.
const ANSWER_AT_ONCE = "require('node:worker_threads').parentPort.postMessage(42);";

const LIMITS: BoundedWorkerLimits = {
  timeoutMs: 10_000,
  rssBudgetBytes: 512 * 1024 * 1024,
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  stackSizeMb: 4,
};

describe('runBoundedWorker', () => {
  it('liefert die erste Nachricht innerhalb der Grenzen', async () => {
    expect(await runBoundedWorker<number>(ANSWER_AT_ONCE, null, LIMITS)).toEqual({
      ok: true,
      value: 42,
    });
  });

  // CI-Lauf 3785: Die Antwort eines Threads wurde vor dem 1-ms-Timer
  // abgearbeitet und als gelesen gewertet, obwohl die Frist abgelaufen war.
  it('wertet eine Antwort nach Fristablauf als Zeitüberschreitung', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await runBoundedWorker<number>(ANSWER_AT_ONCE, null, { ...LIMITS, timeoutMs: 1 }),
      ).toEqual({ ok: false, reason: 'timeout' });
    }
  });

  it('wertet eine Antwort über dem Speicherbudget als Speicherüberschreitung', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await runBoundedWorker<number>(ANSWER_AT_ONCE, null, { ...LIMITS, rssBudgetBytes: -1 }),
      ).toEqual({ ok: false, reason: 'memory' });
    }
  });
});
