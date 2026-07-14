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
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_risk_analyse_queue:
    | { conn: IORedis; queue: Queue<RiskAnalyseLlmJob> }
    | undefined;
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
  // IMMER cachen — nicht nur im Dev: sonst leakt in Produktion jeder Aufruf
  // eine neue IORedis-Connection (bis Redis maxclients erschöpft ist).
  globalThis.__taxtronik_risk_analyse_queue = handle;
  return handle;
}

/** Reiht die LLM-Anreicherung einer Analyse ein. Idempotent über jobId. */
export async function enqueueRiskAnalyseLlm(job: RiskAnalyseLlmJob): Promise<void> {
  const { queue } = getHandle();
  // BullMQ verbietet ':' in Custom-Job-IDs (':' ist ihr interner Key-Separator)
  // — daher '-'. Idempotenz pro Analyse bleibt (analysisId ist eindeutig).
  const jobId = `risk-llm-${job.analysisId}`;
  // Alten Job (failed/completed) mit derselben ID räumen, damit ein erneuter
  // Anstoß durchläuft. Läuft gerade einer (locked), schlägt remove fehl (ok) und
  // der add unten ist ohnehin ein No-Op (ID existiert) → kein Doppellauf.
  await queue.remove(jobId).catch(() => {});
  await queue.add('enrich', job, {
    jobId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
}

/**
 * Liest den BullMQ-Zustand des LLM-Jobs einer Analyse (für die Web-Anzeige).
 * Der Poller erkennt sonst nur `llmEnrichedAt` (= Erfolg) und der Engine-Status,
 * NICHT einen final fehlgeschlagenen Job — die UI zeigte dann endlos „lädt".
 * `removeOnFail: 200` hält gescheiterte Jobs vor, sie sind also abfragbar.
 * Liefert `null`, wenn kein Job (mehr) existiert.
 */
export async function getRiskAnalyseJobState(
  analysisId: string,
): Promise<{ state: string; failedReason: string | null } | null> {
  const { queue } = getHandle();
  const job = await queue.getJob(`risk-llm-${analysisId}`);
  if (!job) return null;
  const state = await job.getState();
  return { state, failedReason: job.failedReason ?? null };
}
