// =============================================================================
// Shared BullMQ producer connection and typed queue registry for the web app.
//
// Queue is a non-blocking BullMQ client and may share one IORedis connection.
// The global registry survives Next.js HMR and also prevents separate producer
// modules from consuming one Redis connection each in production.
// =============================================================================

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@taxtronik/config';
import type { QueueJobDataByName, QueueName } from '@taxtronik/config/job-queues';

import { log } from '@/server/logger';

export const WEB_QUEUE_TIMEOUT_MS = 2_000;

export const WEB_BULLMQ_CONNECTION_OPTIONS = {
  // BullMQ rejects an existing ioredis client with a finite retry count. Web
  // calls are still bounded by withTimeout at their operation boundary.
  maxRetriesPerRequest: null,
} as const;

type CachedQueue = Queue<unknown, void, string>;

interface WebBullMqRegistry {
  connection: IORedis;
  queues: Map<QueueName, CachedQueue>;
}

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_web_bullmq: WebBullMqRegistry | undefined;
}

function createRegistry(): WebBullMqRegistry {
  const connection = new IORedis(env.REDIS_URL, { ...WEB_BULLMQ_CONNECTION_OPTIONS });
  connection.on('error', (err) => {
    log.warn({ component: 'bullmq-web', err: err.message }, 'redis error');
  });
  return { connection, queues: new Map() };
}

function getRegistry(): WebBullMqRegistry {
  const existing = globalThis.__taxtronik_web_bullmq;
  if (existing) return existing;

  const registry = createRegistry();
  globalThis.__taxtronik_web_bullmq = registry;
  return registry;
}

/** Return one typed Queue instance per queue name, all sharing one connection. */
export function getWebQueue<Name extends QueueName>(
  name: Name,
): Queue<QueueJobDataByName[Name], void, string> {
  const registry = getRegistry();
  const existing = registry.queues.get(name);
  if (existing) {
    return existing as unknown as Queue<QueueJobDataByName[Name], void, string>;
  }

  const queue = new Queue<QueueJobDataByName[Name], void, string>(name, {
    connection: registry.connection,
  });
  registry.queues.set(name, queue as unknown as CachedQueue);
  return queue;
}
