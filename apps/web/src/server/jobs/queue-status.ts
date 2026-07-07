// =============================================================================
// Read-only Queue-Status für die Admin-Jobs-Seite (P2-19).
//
// Bisher gab es keine Ops-Einsicht in die BullMQ-Verarbeitung: scheitert ein
// Daily-Job endgültig, stand nur `log.error` im Container-Log — „lief gar
// nicht" fiel niemandem auf. Diese Funktion liest je Queue die Job-Zähler,
// den letzten Completed-Zeitstempel und die letzte Fehlermeldung.
//
// Eine modulweite Connection (maxRetriesPerRequest: null wie bei BullMQ üblich)
// + je Queue ein Queue-Objekt. Rein lesend (getJobCounts/getCompleted/
// getFailed) — es werden KEINE Jobs eingereiht.
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

// Alle vom Worker betriebenen Queues mit Soll-Intervall in Stunden (für die
// „veraltet?"-Einordnung; null = ereignisgetrieben).
//
// SOURCE OF TRUTH der Namen: apps/worker/src/queues.ts. Web hängt nicht vom
// Worker-Package ab (kein gemeinsamer Import möglich) und das Intervall ist
// ohnehin UI-Metadatum ohne Entsprechung im Worker → die Liste bleibt bewusst
// explizit. WICHTIG: Wird dort eine Queue ergänzt/entfernt, MUSS sie auch hier
// gepflegt werden, sonst fehlt sie stillschweigend in der Admin-Übersicht.
const QUEUES: Array<{ name: string; expectedEveryHours: number | null }> = [
  { name: 'evidence-seal', expectedEveryHours: 24 },
  { name: 'audit-verify-check', expectedEveryHours: 24 },
  { name: 'audit-rotate', expectedEveryHours: 24 * 7 },
  { name: 'gwg-expiry-check', expectedEveryHours: 24 },
  { name: 'invoice-overdue-check', expectedEveryHours: 24 },
  { name: 'tax-deadline-materialize', expectedEveryHours: 24 },
  { name: 'tax-news-fetch', expectedEveryHours: 24 },
  { name: 'reminders-daily', expectedEveryHours: 24 },
  { name: 'magic-link-cleanup', expectedEveryHours: 24 },
  { name: 'dsgvo-retention', expectedEveryHours: 24 },
  { name: 'poa-expiry-check', expectedEveryHours: 24 },
  { name: 'backup-run', expectedEveryHours: 24 },
  { name: 'backup-drill', expectedEveryHours: 24 * 31 },
  { name: 'health-alert', expectedEveryHours: null },
  { name: 'n8n-deliver', expectedEveryHours: null },
  { name: 'n8n-outbox-reconcile', expectedEveryHours: null },
  { name: 'risk-analyse-llm', expectedEveryHours: null },
];

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_queue_status: { conn: IORedis; queues: Map<string, Queue> } | undefined;
}

function getHandle(): { conn: IORedis; queues: Map<string, Queue> } {
  const existing = globalThis.__taxtronik_queue_status;
  if (existing) return existing;
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => log.warn({ component: 'queue-status', err: err.message }, 'redis error'));
  const queues = new Map<string, Queue>();
  for (const { name } of QUEUES) queues.set(name, new Queue(name, { connection: conn }));
  const handle = { conn, queues };
  // IMMER cachen — nicht nur im Dev: sonst leakt in Produktion jeder Aufruf
  // eine neue IORedis-Connection samt 17 Queue-Instanzen (pro Seitenaufruf).
  globalThis.__taxtronik_queue_status = handle;
  return handle;
}

export interface QueueStatus {
  name: string;
  expectedEveryHours: number | null;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
  lastFailedReason: string | null;
  /** Overdue: letzter Completed-Lauf älter als das 1,5-fache des Soll-Intervalls. */
  stale: boolean;
}

export async function getQueuesStatus(now: number = Date.now()): Promise<QueueStatus[]> {
  const { queues } = getHandle();
  return Promise.all(
    QUEUES.map(async ({ name, expectedEveryHours }): Promise<QueueStatus> => {
      const q = queues.get(name)!;
      try {
        const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
        const [lastCompleted] = await q.getCompleted(0, 0);
        const [lastFailed] = await q.getFailed(0, 0);
        const lastCompletedAt = lastCompleted?.finishedOn ?? null;
        const stale =
          expectedEveryHours != null &&
          (lastCompletedAt == null ||
            now - lastCompletedAt > expectedEveryHours * 1.5 * 60 * 60 * 1000);
        return {
          name,
          expectedEveryHours,
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
        log.warn({ component: 'queue-status', queue: name, err: (err as Error).message }, 'status read failed');
        return {
          name, expectedEveryHours, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0,
          lastCompletedAt: null, lastFailedAt: null, lastFailedReason: 'Status nicht lesbar', stale: true,
        };
      }
    }),
  );
}
