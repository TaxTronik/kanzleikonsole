// =============================================================================
// BullMQ-Queue für die asynchrone LLM-Phase des Subsumtions-Workspace.
//
// Die schnelle Analyse läuft synchron in der Server-Action; „Mit KI vertiefen" reiht hierüber einen
// Job an den Worker (jobs/risk-analyse-llm.ts), der die Analyse anreichert.
// =============================================================================

import { JOB_QUEUES, type RiskAnalyseLlmJob } from '@taxtronik/config/job-queues';
import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

export type { RiskAnalyseLlmJob } from '@taxtronik/config/job-queues';

/** Reiht die LLM-Anreicherung einer Analyse ein. Idempotent über jobId. */
export async function enqueueRiskAnalyseLlm(job: RiskAnalyseLlmJob): Promise<void> {
  const queue = getWebQueue(JOB_QUEUES.riskAnalyseLlm.name);
  // BullMQ verbietet ':' in Custom-Job-IDs (':' ist ihr interner Key-Separator)
  // — daher '-'. Idempotenz pro Analyse bleibt (analysisId ist eindeutig).
  const jobId = `risk-llm-${job.analysisId}`;
  // Alten Job (failed/completed) mit derselben ID räumen, damit ein erneuter
  // Anstoß durchläuft. Läuft gerade einer (locked), schlägt remove fehl (ok) und
  // der add unten ist ohnehin ein No-Op (ID existiert) → kein Doppellauf.
  await withTimeout(queue.remove(jobId), WEB_QUEUE_TIMEOUT_MS).catch(() => {});
  await withTimeout(
    queue.add('enrich', job, {
      jobId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    }),
    WEB_QUEUE_TIMEOUT_MS,
  );
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
): Promise<{ state: string; failedReason: string | null; workers: number } | null> {
  const queue = getWebQueue(JOB_QUEUES.riskAnalyseLlm.name);
  const job = await withTimeout(queue.getJob(`risk-llm-${analysisId}`), WEB_QUEUE_TIMEOUT_MS);
  if (!job) return null;
  const [state, workers] = await Promise.all([
    withTimeout(job.getState(), WEB_QUEUE_TIMEOUT_MS),
    withTimeout(queue.getWorkersCount(), WEB_QUEUE_TIMEOUT_MS),
  ]);
  return { state, failedReason: job.failedReason ?? null, workers };
}
