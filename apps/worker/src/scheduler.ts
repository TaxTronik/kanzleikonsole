// =============================================================================
// Repeat-Scheduler. Namen, Zeitpläne und Retry-Policies liegen in
// @taxtronik/config/job-queues, damit Worker, Logs und Ops-UI nicht driften.
//
// R-13: Für jeden JOB_QUEUES-Eintrag mit `schedule` wird genau ein Scheduler
// registriert — keine Einzelaufrufe mehr pro Queue.
//
// Idempotent: doppelte Ausführungen pro Tag sind no-ops (notify dedupliziert,
// evidence-seal skippt bereits versiegelte Tage).
// =============================================================================

import type { Queue } from 'bullmq';
import {
  JOB_QUEUES,
  JOB_QUEUE_KEYS,
  SCHEDULE_LOG_LABELS,
  type QueueScheduleDefinition,
} from '@taxtronik/config/job-queues';
import { queues } from './queues';
import { log } from './logger';

export async function setupSchedules(): Promise<void> {
  for (const key of JOB_QUEUE_KEYS) {
    const { name } = JOB_QUEUES[key];
    const schedule: QueueScheduleDefinition | null = JOB_QUEUES[key].schedule;
    if (schedule == null) continue;
    // Repeat-Templates tragen keine Nutzdaten ({}); die typisierte Queue des
    // Schlüssels wird dafür auf die gemeinsame Basis reduziert.
    const queue: Queue = queues[key];
    await queue.upsertJobScheduler(schedule.schedulerId, schedule.repeat, {
      name,
      data: {},
      ...(schedule.jobOptions ? { opts: schedule.jobOptions } : {}),
    });
  }

  log.info({ schedules: SCHEDULE_LOG_LABELS }, 'scheduler: registered');
}
