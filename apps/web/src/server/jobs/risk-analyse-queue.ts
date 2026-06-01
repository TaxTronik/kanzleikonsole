// =============================================================================
// BullMQ-Queue für die asynchrone LLM-Phase des Subsumtions-Workspace.
//
// Singleton auf Modul-Ebene (Muster wie n8n/queue.ts). Die schnelle Analyse
// läuft synchron in der Server-Action; „Mit KI vertiefen" reiht hierüber einen
// Job an den Worker (jobs/risk-analyse-llm.ts), der die Analyse anreichert.
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

export interface RiskAnalyseLlmJob {
  tenantId: string;
  analysisId: string;
  sourceText: string;
  optionen?: Record<string, unknown>;
}

declare global {
  var __taxtronik_risk_analyse_queue: { conn: IORedis; queue: Queue<RiskAnalyseLlmJob> } | undefined;
}

function init(): { conn: IORedis; queue: Queue<RiskAnalyseLlmJob> } {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'risk-analyse-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<RiskAnalyseLlmJob>('risk-analyse-llm', { connection: conn });
  return { conn, queue };
}

function getHandle(): { conn: IORedis; queue: Queue<RiskAnalyseLlmJob> } {
  const existing = globalThis.__taxtronik_risk_analyse_queue;
  if (existing) return existing;

  const handle = init();
  if (env.NODE_ENV !== 'production') {
    globalThis.__taxtronik_risk_analyse_queue = handle;
  }
  return handle;
}

/** Reiht die LLM-Anreicherung einer Analyse ein. Idempotent über jobId. */
export async function enqueueRiskAnalyseLlm(job: RiskAnalyseLlmJob): Promise<void> {
  await getHandle().queue.add('enrich', job, {
    jobId: `risk-llm:${job.analysisId}`,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
}
