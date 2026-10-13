// =============================================================================
// Anstoß der DSGVO-Auskunft im Worker (Welle 15, Folgepunkt P-11).
//
// Fachkatalog: DSGVO-CONTACT-EXPORT-001
//
// Der Auftrag (dsgvo_export) ist zu diesem Zeitpunkt committet; der Job trägt
// nur Tenant- und Auftrags-ID (S-06: keine personenbezogenen Daten in Redis).
// Je Auftrag genau ein Job (jobId); den Zustand liest die Oberfläche aus der
// Datenbank.
// =============================================================================

import {
  DSGVO_EXPORT_JOB_OPTIONS,
  JOB_QUEUES,
  type DsgvoExportJob,
} from '@taxtronik/config/job-queues';
import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

export function dsgvoExportJobId(exportId: string): string {
  // BullMQ verbietet ':' in eigenen Job-IDs.
  return `dsgvo-export-${exportId}`;
}

/** Reiht die Erzeugung eines Auftrags ein; wirft, wenn Redis nicht antwortet. */
export async function enqueueDsgvoExport(job: DsgvoExportJob): Promise<void> {
  const queue = getWebQueue(JOB_QUEUES.dsgvoExport.name);
  const payload: DsgvoExportJob = { tenantId: job.tenantId, exportId: job.exportId };
  await withTimeout(
    queue.add('export', payload, {
      jobId: dsgvoExportJobId(job.exportId),
      ...DSGVO_EXPORT_JOB_OPTIONS,
    }),
    WEB_QUEUE_TIMEOUT_MS,
  );
}
