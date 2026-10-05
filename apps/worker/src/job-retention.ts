// =============================================================================
// S-06: Altersgrenzen auch für Altbestände der Jobs, die früher Inhalte in
// Redis trugen: risk-analyse-llm (Sachverhalt) und reminder-done-notify
// (Betreff der Wiedervorlage, Name der erledigenden Person).
//
// BullMQ wendet removeOnComplete/removeOnFail ({ age, count }) erst an, wenn
// ein weiterer Job abgeschlossen wird. Aufträge der Vorversion trugen die
// Inhalte und nur eine Count-Grenze; ohne neue Läufe blieben sie unbegrenzt in
// Redis (AOF auf Platte). Der Worker räumt deshalb beim Start einmal nach den
// aktuellen Altersgrenzen auf.
// =============================================================================

import type { Queue } from 'bullmq';
import {
  REMINDER_DONE_NOTIFY_JOB_OPTIONS,
  RISK_ANALYSE_LLM_JOB_OPTIONS,
} from '@taxtronik/config/job-queues';
import { queues } from './queues';
import { log } from './logger';

const CLEAN_BATCH = 1_000;

type RetentionQueue = Pick<Queue, 'name' | 'clean'>;

interface RetentionOptions {
  removeOnComplete: { age: number };
  removeOnFail: { age: number };
}

async function trimJobHistory(
  queue: RetentionQueue,
  { removeOnComplete, removeOnFail }: RetentionOptions,
): Promise<{ completed: number; failed: number }> {
  const completed = await queue.clean(removeOnComplete.age * 1_000, CLEAN_BATCH, 'completed');
  const failed = await queue.clean(removeOnFail.age * 1_000, CLEAN_BATCH, 'failed');
  log.info(
    { queue: queue.name, completed: completed.length, failed: failed.length },
    'job-retention: abgelaufene Jobs entfernt',
  );
  return { completed: completed.length, failed: failed.length };
}

export function trimRiskAnalyseJobHistory(
  queue: RetentionQueue = queues.riskAnalyseLlm,
): Promise<{ completed: number; failed: number }> {
  return trimJobHistory(queue, RISK_ANALYSE_LLM_JOB_OPTIONS);
}

export function trimReminderDoneJobHistory(
  queue: RetentionQueue = queues.reminderDoneNotify,
): Promise<{ completed: number; failed: number }> {
  return trimJobHistory(queue, REMINDER_DONE_NOTIFY_JOB_OPTIONS);
}
