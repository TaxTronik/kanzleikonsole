import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  now: 0,
}));

vi.mock('@/server/logger', () => ({
  log: { warn: vi.fn() },
}));

vi.mock('../bullmq', () => ({
  WEB_QUEUE_TIMEOUT_MS: 2_000,
  getWebQueue: (name: string) => ({
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 1,
      failed: 0,
      delayed: 0,
    }),
    getCompleted: vi
      .fn()
      .mockResolvedValue(
        name === 'audit-anchor'
          ? [{ finishedOn: state.now - 20_000 }]
          : name === 'tax-news-fetch'
            ? [{ finishedOn: state.now - 14 * 60 * 60 * 1_000 }]
            : name === 'audit-rotate'
              ? [{ finishedOn: state.now - 60_000, returnvalue: { backlog: 15_000 } }]
              : name === 'storage-orphan-cleanup'
                ? [{ finishedOn: state.now - 60_000, returnvalue: { backlog: 0 } }]
                : [],
      ),
    getFailed: vi.fn().mockResolvedValue([]),
  }),
}));

import { getQueuesStatus, readBacklog } from '../queue-status';

describe('queue status schedule health', () => {
  it('uses shared cadence windows for frequent and daytime-only schedules', async () => {
    state.now = Date.UTC(2026, 7, 27, 12);

    const statuses = new Map(
      (await getQueuesStatus(state.now)).map((status) => [status.name, status]),
    );

    // The two-second anchor has a minimum 30-second grace window.
    expect(statuses.get('audit-anchor')).toMatchObject({ staleAfterMs: 30_000, stale: false });
    // Tax news permits the ten-hour overnight gap plus 50% scheduler grace.
    expect(statuses.get('tax-news-fetch')).toMatchObject({
      expectedMaxGapMs: 10 * 60 * 60 * 1_000,
      staleAfterMs: 15 * 60 * 60 * 1_000,
      stale: false,
    });
    // Event-driven queues never become stale merely because no job completed.
    expect(statuses.get('n8n-deliver')).toMatchObject({ staleAfterMs: null, stale: false });
  });

  it('P-17: reads the backlog reported by the last completed maintenance run', async () => {
    state.now = Date.UTC(2026, 9, 5, 12);

    const statuses = new Map(
      (await getQueuesStatus(state.now)).map((status) => [status.name, status]),
    );

    expect(statuses.get('audit-rotate')?.backlog).toBe(15_000);
    expect(statuses.get('storage-orphan-cleanup')?.backlog).toBe(0);
    // Queues without a backlog contract (or without a completed run) report none.
    expect(statuses.get('audit-anchor')?.backlog).toBeNull();
    expect(statuses.get('n8n-deliver')?.backlog).toBeNull();
  });

  it.each([undefined, null, 'x', {}, { backlog: '3' }, { backlog: -1 }, { backlog: Infinity }])(
    'P-17: ignores a missing or invalid backlog (%o)',
    (returnvalue) => {
      expect(readBacklog(returnvalue)).toBeNull();
    },
  );
});
