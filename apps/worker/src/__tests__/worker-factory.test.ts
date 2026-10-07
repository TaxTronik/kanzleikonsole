import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  constructed: [] as Array<{ name: string; processor: unknown; opts: unknown }>,
  handlers: new Map<string, (...args: unknown[]) => void>(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Worker: class WorkerMock {
    constructor(
      public name: string,
      processor: unknown,
      opts: unknown,
    ) {
      h.constructed.push({ name, processor, opts });
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      h.handlers.set(event, handler);
      return this;
    }
  },
}));
vi.mock('../logger', () => ({ log: h.log }));

import { currentJobLogContext } from '../log-context';
import { createWorker, logJobFailure, logWorkerError } from '../worker-factory';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'deliver',
    attemptsMade: 1,
    opts: { attempts: 3 },
    finishedOn: undefined,
    data: { subject: 'personal data must not be logged' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.constructed.length = 0;
  h.handlers.clear();
});

describe('F-05 createWorker', () => {
  it('passes the constructor arguments through and attaches failed and error handlers', () => {
    const processor = vi.fn();
    const connection = {};
    const worker = createWorker('queue-a', processor, {
      connection: connection as never,
      concurrency: 4,
    });

    expect(h.constructed).toEqual([
      { name: 'queue-a', processor: expect.any(Function), opts: { connection, concurrency: 4 } },
    ]);
    expect(worker.name).toBe('queue-a');
    expect([...h.handlers.keys()].sort()).toEqual(['error', 'failed']);

    h.handlers.get('failed')!(job({ attemptsMade: 3, finishedOn: 1 }), new Error('boom'));
    h.handlers.get('error')!(new Error('lock lost'));
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'queue-a', jobId: 'job-1', err: 'boom' }),
      'worker: job failed',
    );
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'queue-a', err: 'lock lost' }),
      'worker: error',
    );
  });
});

// F-06: Jeder Job läuft im Log-Kontext aus Queue und Job-ID.
describe('F-06 job log context', () => {
  it('runs the processor with queue and job id as log context across awaits', async () => {
    const seen: unknown[] = [];
    const processor = vi.fn(async (_job: unknown, token?: string) => {
      seen.push(currentJobLogContext());
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(currentJobLogContext());
      return `done:${token}`;
    });
    createWorker('queue-a', processor, { connection: {} as never });
    const wrapped = h.constructed[0]!.processor as (...args: unknown[]) => Promise<unknown>;

    const signal = new AbortController().signal;
    await expect(wrapped(job(), 'lock-token', signal)).resolves.toBe('done:lock-token');

    expect(processor).toHaveBeenCalledWith(job(), 'lock-token', signal);
    expect(seen).toEqual([
      { queue: 'queue-a', jobId: 'job-1' },
      { queue: 'queue-a', jobId: 'job-1' },
    ]);
    expect(currentJobLogContext()).toBeUndefined();
  });

  it('keeps concurrent jobs apart and propagates processor errors unchanged', async () => {
    const processor = vi.fn(async (current: { id?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, current.id === 'job-1' ? 5 : 1));
      if (current.id === 'job-2') throw new Error('boom');
      return currentJobLogContext();
    });
    createWorker('queue-b', processor, { connection: {} as never });
    const wrapped = h.constructed[0]!.processor as (...args: unknown[]) => Promise<unknown>;

    const [first, second] = await Promise.allSettled([
      wrapped(job()),
      wrapped(job({ id: 'job-2' })),
    ]);

    expect(first).toEqual({ status: 'fulfilled', value: { queue: 'queue-b', jobId: 'job-1' } });
    expect(second).toMatchObject({ status: 'rejected', reason: { message: 'boom' } });
  });

  it('uses null as job id when BullMQ has not assigned one', async () => {
    const processor = vi.fn(async () => currentJobLogContext());
    createWorker('queue-c', processor, { connection: {} as never });
    const wrapped = h.constructed[0]!.processor as (...args: unknown[]) => Promise<unknown>;

    await expect(wrapped(job({ id: undefined }))).resolves.toEqual({
      queue: 'queue-c',
      jobId: null,
    });
  });
});

describe('F-05 failed-job logging', () => {
  it('logs a failed attempt with a pending retry as a warning without job data', () => {
    logJobFailure('n8n-deliver', job() as never, new Error('HTTP 502'));

    expect(h.log.error).not.toHaveBeenCalled();
    const [fields, message] = h.log.warn.mock.calls[0]!;
    expect(message).toBe('worker: job failed, retry pending');
    expect(fields).toEqual({
      queue: 'n8n-deliver',
      jobId: 'job-1',
      jobName: 'deliver',
      attemptsMade: 1,
      attempts: 3,
      retryPending: true,
      err: 'HTTP 502',
      errName: 'Error',
    });
  });

  it('logs the final failure as an error with stack', () => {
    logJobFailure(
      'backup-run',
      job({ attemptsMade: 2, opts: { attempts: 2 }, finishedOn: 1_700_000_000_000 }) as never,
      new Error('pg_dump failed'),
    );

    const [fields, message] = h.log.error.mock.calls[0]!;
    expect(message).toBe('worker: job failed');
    expect(fields).toMatchObject({
      queue: 'backup-run',
      attemptsMade: 2,
      attempts: 2,
      retryPending: false,
      err: 'pg_dump failed',
    });
    expect(fields.stack).toContain('pg_dump failed');
    expect(JSON.stringify(fields)).not.toContain('personal data');
  });

  it('treats an unrecoverable failure before the last attempt as final', () => {
    // BullMQ sets finishedOn when it will not retry (UnrecoverableError).
    logJobFailure(
      'risk-analyse-llm',
      job({ attemptsMade: 1, opts: { attempts: 2 }, finishedOn: 1 }) as never,
      Object.assign(new Error('KI-Vertiefung nicht verfügbar'), { name: 'UnrecoverableError' }),
    );
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ retryPending: false, errName: 'UnrecoverableError' }),
      'worker: job failed',
    );
  });

  it('still logs when BullMQ reports a failure without a job', () => {
    logJobFailure('audit-anchor', undefined, new Error('job stalled more than allowable limit'));
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'audit-anchor', jobId: null, attemptsMade: null }),
      'worker: job failed',
    );
  });
});

describe('F-05 worker error logging', () => {
  it('logs every non-connection error', () => {
    logWorkerError('evidence-seal', new Error('Missing lock for job 7'), 0);
    logWorkerError('evidence-seal', new Error('Missing lock for job 7'), 1);
    expect(h.log.error).toHaveBeenCalledTimes(2);
  });

  it('logs a shared Redis outage once per minute and counts suppressed reports', () => {
    const refused = () =>
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });
    const start = 10_000_000;
    logWorkerError('queue-a', refused(), start);
    logWorkerError('queue-b', refused(), start + 1_000);
    logWorkerError('queue-c', refused(), start + 59_000);
    expect(h.log.error).toHaveBeenCalledTimes(1);

    logWorkerError('queue-a', refused(), start + 60_000);
    expect(h.log.error).toHaveBeenCalledTimes(2);
    expect(h.log.error).toHaveBeenLastCalledWith(
      expect.objectContaining({ queue: 'queue-a', suppressedSinceLastLog: 2 }),
      'worker: redis connection error',
    );
  });
});
