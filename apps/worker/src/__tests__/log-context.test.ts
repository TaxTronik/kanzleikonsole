// F-06: Jede Logzeile eines Jobs trägt Queue und Job-ID — auch nach await und
// in Timern; Zeilen außerhalb eines Jobs bleiben ohne diese Felder.
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runWithJobLogContext } from '../log-context';
import { createLogger } from '../logger';

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { log: createLogger(stream), lines };
}

describe('F-06 worker job log context', () => {
  it('schreibt Queue und Job-ID in jede Zeile des Jobs', async () => {
    const { log, lines } = captureLogger();

    await runWithJobLogContext({ queue: 'audit-rotate', jobId: '42' }, async () => {
      log.info('Start');
      await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          log.warn({ tenantId: 'tenant-1' }, 'im Timer');
          resolve();
        }, 1),
      );
    });
    log.info('außerhalb');

    expect(lines).toEqual([
      expect.objectContaining({ msg: 'Start', queue: 'audit-rotate', jobId: '42' }),
      expect.objectContaining({
        msg: 'im Timer',
        queue: 'audit-rotate',
        jobId: '42',
        tenantId: 'tenant-1',
      }),
      expect.not.objectContaining({ queue: expect.anything() }),
    ]);
    expect(lines[2]).not.toHaveProperty('jobId');
  });

  it('lässt ausdrücklich geloggte Felder gewinnen', () => {
    const { log, lines } = captureLogger();
    runWithJobLogContext({ queue: 'mail-outbox-deliver', jobId: '7' }, () =>
      log.error({ queue: 'n8n-deliver', jobId: '8' }, 'explizit'),
    );
    expect(lines[0]).toMatchObject({ queue: 'n8n-deliver', jobId: '8' });
  });
});
