// =============================================================================
// Rückstand der Wartungsjobs als Health-Kennzahl (P-17 / B14).
//
// audit-rotate und storage-orphan-cleanup melden im Ergebnis jedes vollständigen
// Laufs `backlogStatus` (apps/worker/src/maintenance-backlog.ts): fällige,
// weiterhin offene Einträge, Fälligkeit des ältesten davon, Läufe in Folge mit
// Rückstand, ob die Alarmschwelle erreicht ist, und die Schwelle selbst. Dieses
// Modul liest den Wert des letzten erfolgreichen Laufs für die Jobübersicht und
// für GET /api/health/detail (ADMIN/PARTNER). Das Alter des ältesten offenen
// Eintrags wird zum Abfragezeitpunkt berechnet; zwischen zwei Läufen wächst es
// also weiter. Tenant-Bezug enthält die Kennzahl nicht; die öffentliche
// /api/health bleibt beim binären Status (N3).
//
// Rein lesend (getCompleted); es werden keine Jobs eingereiht.
// =============================================================================

import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { log } from '@/server/logger';

import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

/** Wartungsjobs, die einen Rückstand melden. */
export const MAINTENANCE_QUEUES = [
  JOB_QUEUES.auditRotate.name,
  JOB_QUEUES.storageOrphanCleanup.name,
] as const;

type MaintenanceQueue = (typeof MAINTENANCE_QUEUES)[number];

export interface MaintenanceBacklogThreshold {
  /** Läufe in Folge mit Rückstand, ab denen der Worker alarmiert. */
  consecutiveRuns: number;
  /** Höchstdauer, die der älteste offene Eintrag fällig sein darf (ms). */
  maxOverdueMs: number;
}

/** `backlogStatus` aus dem Job-Ergebnis (Vertrag mit dem Worker). */
export interface MaintenanceBacklogStatus {
  count: number;
  /** Fälligkeit des ältesten offenen Eintrags (ISO-8601); null ohne Rückstand. */
  oldestDueAt: string | null;
  consecutiveRuns: number;
  alarm: boolean;
  threshold: MaintenanceBacklogThreshold;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readThreshold(value: unknown): MaintenanceBacklogThreshold | null {
  const threshold = asRecord(value);
  if (!threshold) return null;
  const { consecutiveRuns, maxOverdueMs } = threshold;
  return isCount(consecutiveRuns) && isCount(maxOverdueMs)
    ? { consecutiveRuns, maxOverdueMs }
    : null;
}

/** B14: `backlogStatus` aus dem Ergebnis eines Jobs, sofern vollständig und gültig. */
export function readBacklogStatus(returnvalue: unknown): MaintenanceBacklogStatus | null {
  const status = asRecord(asRecord(returnvalue)?.['backlogStatus']);
  if (!status) return null;
  const { count, oldestDueAt, consecutiveRuns, alarm } = status;
  const threshold = readThreshold(status['threshold']);
  const dueValid =
    oldestDueAt === null ||
    (typeof oldestDueAt === 'string' && !Number.isNaN(Date.parse(oldestDueAt)));
  if (!isCount(count) || !isCount(consecutiveRuns) || typeof alarm !== 'boolean') return null;
  if (!dueValid || !threshold) return null;
  return { count, oldestDueAt: oldestDueAt as string | null, consecutiveRuns, alarm, threshold };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Die Alarmschwelle als Satz für die Jobübersicht. */
export function describeBacklogThreshold(threshold: MaintenanceBacklogThreshold): string {
  const runs =
    threshold.consecutiveRuns === 1 ? '1 Lauf' : `${threshold.consecutiveRuns} Läufen in Folge`;
  const days = threshold.maxOverdueMs / DAY_MS;
  const hours = Math.round(threshold.maxOverdueMs / HOUR_MS);
  const age = Number.isInteger(days)
    ? `${days} ${days === 1 ? 'Tag' : 'Tagen'}`
    : `${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`;
  return `Rückstand nach ${runs} oder ältester offener Eintrag seit mehr als ${age} fällig`;
}

/** Alter des ältesten offenen Eintrags seit seiner Fälligkeit zum Zeitpunkt `now`. */
export function oldestPendingAgeMs(
  status: Pick<MaintenanceBacklogStatus, 'oldestDueAt'> | null,
  now: number,
): number | null {
  if (!status?.oldestDueAt) return null;
  return Math.max(0, now - Date.parse(status.oldestDueAt));
}

export interface MaintenanceJobHealth {
  queue: string;
  /** Status in Redis lesbar. */
  readable: boolean;
  /** Ende des letzten erfolgreichen Laufs (ISO-8601); null = noch keiner. */
  lastRunAt: string | null;
  /** Fällige, weiterhin offene Einträge laut letztem Lauf; null = keine Angabe. */
  backlog: number | null;
  /** Fälligkeit des ältesten offenen Eintrags (ISO-8601). */
  oldestPendingDueAt: string | null;
  /** Alter des ältesten offenen Eintrags seit Fälligkeit, zum Abfragezeitpunkt (ms). */
  oldestPendingAgeMs: number | null;
  /** Läufe in Folge, die mit Rückstand endeten. */
  consecutiveRuns: number | null;
  /** Alarmschwelle laut letztem Lauf erreicht. */
  alarm: boolean;
  threshold: MaintenanceBacklogThreshold | null;
}

export interface MaintenanceHealth {
  /** alarm: mindestens ein Job über der Schwelle; unknown: ein Status war nicht lesbar. */
  status: 'ok' | 'alarm' | 'unknown';
  jobs: MaintenanceJobHealth[];
}

function readLegacyBacklog(returnvalue: unknown): number | null {
  const backlog = asRecord(returnvalue)?.['backlog'];
  return isCount(backlog) ? backlog : null;
}

async function readJobHealth(queue: MaintenanceQueue, now: number): Promise<MaintenanceJobHealth> {
  try {
    const [last] = await withTimeout(getWebQueue(queue).getCompleted(0, 0), WEB_QUEUE_TIMEOUT_MS);
    const status = readBacklogStatus(last?.returnvalue);
    return {
      queue,
      readable: true,
      lastRunAt: last?.finishedOn ? new Date(last.finishedOn).toISOString() : null,
      backlog: status?.count ?? readLegacyBacklog(last?.returnvalue),
      oldestPendingDueAt: status?.oldestDueAt ?? null,
      oldestPendingAgeMs: oldestPendingAgeMs(status, now),
      consecutiveRuns: status?.consecutiveRuns ?? null,
      alarm: status?.alarm ?? false,
      threshold: status?.threshold ?? null,
    };
  } catch (err) {
    log.warn(
      { component: 'maintenance-backlog', queue, err: (err as Error).message },
      'status read failed',
    );
    return {
      queue,
      readable: false,
      lastRunAt: null,
      backlog: null,
      oldestPendingDueAt: null,
      oldestPendingAgeMs: null,
      consecutiveRuns: null,
      alarm: false,
      threshold: null,
    };
  }
}

/** B14: Rückstand der Wartungsjobs für GET /api/health/detail. */
export async function getMaintenanceBacklogHealth(
  now: number = Date.now(),
): Promise<MaintenanceHealth> {
  const jobs = await Promise.all(MAINTENANCE_QUEUES.map((queue) => readJobHealth(queue, now)));
  const status = jobs.some((job) => job.alarm)
    ? 'alarm'
    : jobs.every((job) => job.readable)
      ? 'ok'
      : 'unknown';
  return { status, jobs };
}
