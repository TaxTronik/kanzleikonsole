// =============================================================================
// S-06: Altersgrenze für die LLM-Aufträge der Subsumtion auch für Altbestände.
//
// BullMQ wendet removeOnComplete/removeOnFail ({ age, count }) erst an, wenn
// ein weiterer Job abgeschlossen wird. Aufträge der Vorversion trugen den
// vollständigen Sachverhalt und nur eine Count-Grenze; ohne neue Läufe blieben
// sie unbegrenzt in Redis (AOF auf Platte). Der Worker räumt deshalb beim Start
// einmal nach den aktuellen Altersgrenzen auf.
// =============================================================================

import type { Queue } from 'bullmq';
import { RISK_ANALYSE_LLM_JOB_OPTIONS } from '@taxtronik/config/job-queues';
import { queues } from './queues';
import { log } from './logger';

const CLEAN_BATCH = 1_000;

export async function trimRiskAnalyseJobHistory(
  queue: Pick<Queue, 'name' | 'clean'> = queues.riskAnalyseLlm,
): Promise<{ completed: number; failed: number }> {
  const { removeOnComplete, removeOnFail } = RISK_ANALYSE_LLM_JOB_OPTIONS;
  const completed = await queue.clean(removeOnComplete.age * 1_000, CLEAN_BATCH, 'completed');
  const failed = await queue.clean(removeOnFail.age * 1_000, CLEAN_BATCH, 'failed');
  log.info(
    { queue: queue.name, completed: completed.length, failed: failed.length },
    'job-retention: abgelaufene risk-analyse-llm-Jobs entfernt',
  );
  return { completed: completed.length, failed: failed.length };
}
