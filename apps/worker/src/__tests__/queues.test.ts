import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queueOptions: [] as Array<{
    defaultJobOptions?: {
      removeOnComplete?: { age?: number; count?: number };
      removeOnFail?: { age?: number; count?: number };
    };
  }>,
}));

vi.mock('@taxtronik/config', () => ({
  env: { REDIS_URL: 'redis://queue.test:6379' },
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {},
}));

vi.mock('bullmq', () => ({
  Queue: class QueueMock {
    constructor(_name: string, options: (typeof mocks.queueOptions)[number]) {
      mocks.queueOptions.push(options);
    }
  },
}));

import { QUEUE_STATUS_HISTORY_RETENTION_SECONDS } from '@taxtronik/config/job-queues';
import '../queues';

describe('worker queue history retention', () => {
  it('keeps bounded success and failure markers for the full health horizon', () => {
    expect(mocks.queueOptions.length).toBeGreaterThan(0);
    for (const options of mocks.queueOptions) {
      expect(options.defaultJobOptions).toMatchObject({
        removeOnComplete: { age: QUEUE_STATUS_HISTORY_RETENTION_SECONDS, count: 500 },
        removeOnFail: { age: QUEUE_STATUS_HISTORY_RETENTION_SECONDS, count: 500 },
      });
    }
  });
});
