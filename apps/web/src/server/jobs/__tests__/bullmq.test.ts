import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{ url: string; options: unknown; on: ReturnType<typeof vi.fn> }>,
  queues: [] as Array<{ name: string; options: { connection: unknown } }>,
}));

vi.mock('@taxtronik/config', () => ({
  env: { REDIS_URL: 'redis://queue.test:6379' },
}));

vi.mock('@/server/logger', () => ({
  log: { warn: vi.fn() },
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    readonly on = vi.fn();

    constructor(url: string, options: unknown) {
      mocks.connections.push({ url, options, on: this.on });
    }
  },
}));

vi.mock('bullmq', () => ({
  Queue: class QueueMock {
    constructor(
      readonly name: string,
      readonly options: { connection: unknown },
    ) {
      mocks.queues.push({ name, options });
    }
  },
}));

import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { getWebQueue, WEB_BULLMQ_CONNECTION_OPTIONS, WEB_QUEUE_TIMEOUT_MS } from '../bullmq';

describe('web BullMQ registry', () => {
  beforeEach(() => {
    globalThis.__taxtronik_web_bullmq = undefined;
    mocks.connections.length = 0;
    mocks.queues.length = 0;
  });

  it('shares one Redis connection across queue modules and caches queue handles', () => {
    const first = getWebQueue(JOB_QUEUES.auditVerify.name);
    const same = getWebQueue(JOB_QUEUES.auditVerify.name);
    getWebQueue(JOB_QUEUES.n8nDeliver.name);

    expect(same).toBe(first);
    expect(mocks.connections).toHaveLength(1);
    expect(mocks.connections[0]).toMatchObject({
      url: 'redis://queue.test:6379',
      options: WEB_BULLMQ_CONNECTION_OPTIONS,
    });
    expect(mocks.queues.map((queue) => queue.name)).toEqual([
      JOB_QUEUES.auditVerify.name,
      JOB_QUEUES.n8nDeliver.name,
    ]);
    expect(mocks.queues[0]?.options.connection).toBe(mocks.queues[1]?.options.connection);
  });

  it('keeps producer calls time-bounded despite BullMQ retry requirements', () => {
    expect(WEB_BULLMQ_CONNECTION_OPTIONS.maxRetriesPerRequest).toBeNull();
    expect(WEB_QUEUE_TIMEOUT_MS).toBe(2_000);
  });
});
