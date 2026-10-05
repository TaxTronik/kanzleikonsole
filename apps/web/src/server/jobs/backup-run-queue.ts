// =============================================================================
// Manueller Backup-Lauf aus der Admin-Übersicht (P-22).
//
// Der Button wartet nicht mehr im HTTP-Request auf pg_dump, SHA-256 und Upload
// (504 nach proxy_read_timeout, während das Backup weiterlief), sondern reiht
// den vorhandenen Worker-Job backup-run ein. Doppelstarts verhindern Queue und
// Datenbank statt einer Modulvariablen: eine feste jobId (BullMQ legt je ID
// höchstens einen Job an), die Worker-Concurrency 1 und ein frischer
// RUNNING-BackupRecord.
// =============================================================================

import { JOB_QUEUES } from '@taxtronik/config/job-queues';

import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

/** Wie STALE_RUNNING_MS im Worker: ältere RUNNING-Records gelten als verwaist. */
export const BACKUP_RUNNING_STALE_MS = 6 * 60 * 60 * 1000;

const PENDING_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children', 'active']);

export type ManualBackupJobState =
  | 'waiting'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children'
  | 'active'
  | 'completed'
  | 'failed'
  | 'unknown';

function manualBackupJobId(tenantId: string): string {
  // BullMQ verbietet ':' in Custom-Job-IDs.
  return `backup-run-manual-${tenantId}`;
}

/** Zustand des zuletzt manuell eingereihten Laufs; null, wenn keiner (mehr) bekannt ist. */
export async function getManualBackupJobState(
  tenantId: string,
): Promise<ManualBackupJobState | null> {
  const queue = getWebQueue(JOB_QUEUES.backupRun.name);
  const job = await withTimeout(queue.getJob(manualBackupJobId(tenantId)), WEB_QUEUE_TIMEOUT_MS);
  if (!job) return null;
  return (await withTimeout(job.getState(), WEB_QUEUE_TIMEOUT_MS)) as ManualBackupJobState;
}

export function isPendingBackupJobState(state: ManualBackupJobState | null): boolean {
  return state !== null && PENDING_STATES.has(state);
}

/**
 * Reiht den Worker-Job ein. `false`, wenn bereits ein manueller Lauf wartet
 * oder läuft. Ein abgeschlossener Vorlauf mit derselben jobId wird vorher
 * entfernt; ein laufender Job ist gesperrt und bleibt unangetastet.
 */
export async function enqueueManualBackup(
  tenantId: string,
  requestedByStaffId: string,
): Promise<boolean> {
  if (isPendingBackupJobState(await getManualBackupJobState(tenantId))) return false;
  const queue = getWebQueue(JOB_QUEUES.backupRun.name);
  const jobId = manualBackupJobId(tenantId);
  await withTimeout(queue.remove(jobId), WEB_QUEUE_TIMEOUT_MS).catch(() => undefined);
  await withTimeout(
    queue.add(
      JOB_QUEUES.backupRun.name,
      { tenantId, requestedByStaffId },
      {
        jobId,
        // Kein automatischer Retry eines manuellen Laufs; der Status bleibt
        // für die Abfrage der Admin-Übersicht eine Weile sichtbar.
        attempts: 1,
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    ),
    WEB_QUEUE_TIMEOUT_MS,
  );
  return true;
}
