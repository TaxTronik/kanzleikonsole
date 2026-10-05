// =============================================================================
// BullMQ-Queue für die asynchrone LLM-Phase des Subsumtions-Workspace.
//
// Die schnelle Analyse läuft synchron in der Server-Action; „Mit KI vertiefen" reiht hierüber einen
// Job an den Worker (jobs/risk-analyse-llm.ts), der die Analyse anreichert.
//
// S-06: Der Job trägt nur { tenantId, analysisId, sourceHash } — nie den
// Sachverhalt. Redis persistiert Jobs per AOF auf Platte, außerhalb von
// Archivierung und DSGVO-Löschung; der Worker liest den Text selbst aus der
// Datenbank und prüft den Hash.
// =============================================================================

import {
  JOB_QUEUES,
  RISK_ANALYSE_LLM_JOB_OPTIONS,
  type RiskAnalyseLlmJob,
} from '@taxtronik/config/job-queues';
import { riskSourceHash } from '@taxtronik/db/risk-analysis';
import { withTimeout } from '@/lib/with-timeout';
import { log } from '@/server/logger';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

export type { RiskAnalyseLlmJob } from '@taxtronik/config/job-queues';

/** Anstoß der LLM-Phase; der Sachverhalt dient nur zur Hash-Bildung. */
export interface RiskAnalyseLlmRequest {
  tenantId: string;
  analysisId: string;
  /** Der gespeicherte Sachverhalt, den die Anreicherung analysieren soll. */
  sourceText: string;
}

/** Reiht die LLM-Anreicherung einer Analyse ein. Idempotent über jobId. */
export async function enqueueRiskAnalyseLlm(request: RiskAnalyseLlmRequest): Promise<void> {
  const job: RiskAnalyseLlmJob = {
    tenantId: request.tenantId,
    analysisId: request.analysisId,
    sourceHash: riskSourceHash(request.sourceText),
  };
  const queue = getWebQueue(JOB_QUEUES.riskAnalyseLlm.name);
  // BullMQ verbietet ':' in Custom-Job-IDs (':' ist ihr interner Key-Separator)
  // — daher '-'. Idempotenz pro Analyse bleibt (analysisId ist eindeutig).
  const jobId = `risk-llm-${job.analysisId}`;
  // Alten Job (failed/completed) mit derselben ID räumen, damit ein erneuter
  // Anstoß durchläuft. Läuft gerade einer (locked), schlägt remove fehl und der
  // add unten ist ohnehin ein No-Op (ID existiert) → kein Doppellauf.
  await withTimeout(queue.remove(jobId), WEB_QUEUE_TIMEOUT_MS).catch((err: unknown) => {
    log.warn(
      {
        component: 'risk-analyse-queue',
        analysisId: job.analysisId,
        err: err instanceof Error ? err.message : String(err),
      },
      'risk-analyse-queue: vorheriger Job nicht entfernt (läuft noch oder Redis langsam)',
    );
  });
  await withTimeout(
    queue.add('enrich', job, { jobId, ...RISK_ANALYSE_LLM_JOB_OPTIONS }),
    WEB_QUEUE_TIMEOUT_MS,
  );
}

/**
 * Liest den BullMQ-Zustand des LLM-Jobs einer Analyse (für die Web-Anzeige).
 * Der Poller erkennt sonst nur `llmEnrichedAt` (= Erfolg) und der Engine-Status,
 * NICHT einen final fehlgeschlagenen Job — die UI zeigte dann endlos „lädt".
 * `removeOnFail` hält gescheiterte Jobs 7 Tage (max. 200) vor, sie sind also
 * abfragbar. Liefert `null`, wenn kein Job (mehr) existiert.
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
