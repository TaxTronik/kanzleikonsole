import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDashboardMutationQueue } from '../mutation-queue';

describe('Dashboard-Mutationsqueue', () => {
  it('laesst einen spaeteren Layout-Snapshot den vorherigen erst nach dessen Abschluss speichern', async () => {
    const queue = createDashboardMutationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = queue.enqueue(async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('setzt die Queue nach einem fehlgeschlagenen Save fort', async () => {
    const queue = createDashboardMutationQueue();
    const afterFailure: string[] = [];
    await expect(
      queue.enqueue(async () => {
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');

    await queue.enqueue(async () => {
      afterFailure.push('saved');
    });
    expect(afterFailure).toEqual(['saved']);
  });

  it('reiht auch Standard-Reset ein und verwirft einen ausstehenden Debounce-Timer', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard-grid.tsx'),
      'utf8',
    );

    expect(source).toContain('clearTimeout(saveTimer.current)');
    expect(source).toContain('await enqueueMutation(async () => {');
    expect(source).toContain('const r = await resetDashboardLayoutAction()');
    expect(source).toContain('if (resettingRef.current) return;');
  });
});
