import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queues: [] as Array<{
    name: string;
    options: {
      defaultJobOptions?: {
        removeOnComplete?: { age?: number; count?: number };
        removeOnFail?: { age?: number; count?: number };
      };
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
    constructor(
      public name: string,
      options: (typeof mocks.queues)[number]['options'],
    ) {
      mocks.queues.push({ name, options });
    }
  },
}));

import {
  JOB_QUEUES,
  JOB_QUEUE_KEYS,
  QUEUE_STATUS_HISTORY_RETENTION_SECONDS,
} from '@taxtronik/config/job-queues';
import { queues } from '../queues';

describe('worker queue history retention', () => {
  it('keeps bounded success and failure markers for the full health horizon', () => {
    expect(mocks.queues.length).toBeGreaterThan(0);
    for (const { options } of mocks.queues) {
      expect(options.defaultJobOptions).toMatchObject({
        removeOnComplete: { age: QUEUE_STATUS_HISTORY_RETENTION_SECONDS, count: 500 },
        removeOnFail: { age: QUEUE_STATUS_HISTORY_RETENTION_SECONDS, count: 500 },
      });
    }
  });
});

describe('R-13 generated worker queues', () => {
  it('creates exactly one producer queue per JOB_QUEUES entry, in declaration order', () => {
    expect(mocks.queues.map((queue) => queue.name)).toEqual(
      Object.values(JOB_QUEUES).map((queue) => queue.name),
    );
    expect(Object.keys(queues)).toEqual([...JOB_QUEUE_KEYS]);
    for (const key of JOB_QUEUE_KEYS) {
      expect((queues[key] as unknown as { name: string }).name).toBe(JOB_QUEUES[key].name);
    }
  });
});
