// =============================================================================
// Read-only Queue-Status für die Admin-Jobs-Seite (P2-19).
//
// Bisher gab es keine Ops-Einsicht in die BullMQ-Verarbeitung: scheitert ein
// Daily-Job endgültig, stand nur `log.error` im Container-Log — „lief gar
// nicht" fiel niemandem auf. Diese Funktion liest je Queue die Job-Zähler,
// den letzten Completed-Zeitstempel und die letzte Fehlermeldung.
//
// Queue-Namen und Health-Fenster kommen aus derselben runtime-leichten Quelle
// wie der Worker-Scheduler. Rein lesend (getJobCounts/getCompleted/getFailed)
// — es werden KEINE Jobs eingereiht.
// =============================================================================

import { QUEUE_HEALTH } from '@taxtronik/config/job-queues';
import { log } from '@/server/logger';

import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

export interface QueueStatus {
  name: string;
  expectedMaxGapMs: number | null;
  staleAfterMs: number | null;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
  lastFailedReason: string | null;
  /** Overdue according to the shared schedule's health grace window. */
  stale: boolean;
}

export async function getQueuesStatus(now: number = Date.now()): Promise<QueueStatus[]> {
  return Promise.all(
    QUEUE_HEALTH.map(async ({ name, expectedMaxGapMs, staleAfterMs }): Promise<QueueStatus> => {
      const q = getWebQueue(name);
      try {
        // Das try/catch unten faengt Fehler, aber kein Haengen: bei Redis-
        // Ausfall parkt ioredis den Befehl und das Promise resolved nie — die
        // Admin-Seite bliebe endlos im Laden. Deshalb zusaetzlich gedeckelt.
        const counts = await withTimeout(
          q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
          WEB_QUEUE_TIMEOUT_MS,
        );
        const [lastCompleted] = await withTimeout(q.getCompleted(0, 0), WEB_QUEUE_TIMEOUT_MS);
        const [lastFailed] = await withTimeout(q.getFailed(0, 0), WEB_QUEUE_TIMEOUT_MS);
        const lastCompletedAt = lastCompleted?.finishedOn ?? null;
        const stale =
          staleAfterMs != null && (lastCompletedAt == null || now - lastCompletedAt > staleAfterMs);
        return {
          name,
          expectedMaxGapMs,
          staleAfterMs,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          lastCompletedAt,
          lastFailedAt: lastFailed?.finishedOn ?? null,
          lastFailedReason: lastFailed?.failedReason ?? null,
          stale,
        };
      } catch (err) {
        log.warn(
          { component: 'queue-status', queue: name, err: (err as Error).message },
          'status read failed',
        );
        return {
          name,
          expectedMaxGapMs,
          staleAfterMs,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          lastCompletedAt: null,
          lastFailedAt: null,
          lastFailedReason: 'Status nicht lesbar',
          stale: true,
        };
      }
    }),
  );
}
