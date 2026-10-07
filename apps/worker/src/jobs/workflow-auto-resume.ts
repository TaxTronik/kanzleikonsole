// =============================================================================
// workflow-auto-resume — zeitgesteuertes Fortsetzen pausierter Workflows.
//
// F-13: Vorher setzte erst das Rendern der Workflow-Seite eines Mandanten
// (autoResumePausedWorkflows) fällige Instanzen des ganzen Tenants auf ACTIVE —
// bis dahin blieben sie in Übersicht, Dashboard und Arbeitskorb pausiert, und
// ein Seitenaufruf schrieb unter dem Audit-Lock. Jetzt läuft das alle 5 Minuten
// hier: je Instanz eine kurze Transaktion im Tenant-Kontext (CAS + Evidence),
// damit der Audit-Lock nie über mehrere Instanzen gehalten wird.
// =============================================================================

// Fachkatalog: WORKFLOW-LIFECYCLE-001.
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { withSystemContext } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { resumeElapsedPausedWorkflowTx } from '@taxtronik/db/workflow-lifecycle';
import { createWorker } from '../worker-factory';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { isWorkerTenantModuleEnabled } from '../module-gate';
import { log } from '../logger';

const evidence = new EvidenceService(new LocalTimestampAdapter());

/** Obergrenze je Lauf; ein Rest folgt im nächsten Lauf. */
const BATCH = 500;

export async function runWorkflowAutoResume(now = new Date()) {
  // S-01: Die mandantenübergreifende Kandidatensuche (nur ID und Tenant) liest der
  // Owner-Client; jede Instanz wird danach über die App-Rolle fortgesetzt.
  const due = await prismaOwner.workflowInstance.findMany({
    where: { status: 'PAUSED', pausedUntil: { not: null, lte: now } },
    select: { id: true, tenantId: true },
    orderBy: [{ tenantId: 'asc' }, { pausedUntil: 'asc' }, { id: 'asc' }],
    take: BATCH,
  });
  const moduleEnabled = new Map<string, boolean>();
  let resumed = 0,
    unchanged = 0,
    moduleDisabled = 0,
    failed = 0;
  for (const candidate of due) {
    const { tenantId } = candidate;
    try {
      if (!moduleEnabled.has(tenantId)) {
        moduleEnabled.set(tenantId, await isWorkerTenantModuleEnabled(tenantId, 'workflows'));
      }
      // Ausgeschaltetes Workflow-Modul: keine Hintergrundänderung; nach dem
      // Wiedereinschalten setzt der nächste Lauf fort.
      if (!moduleEnabled.get(tenantId)) {
        moduleDisabled += 1;
        continue;
      }
      const after = await withSystemContext(tenantId, async (tx) => {
        const state = await resumeElapsedPausedWorkflowTx(tx, {
          tenantId,
          instanceId: candidate.id,
          now,
        });
        // Parallel verlängert oder abgebrochen: weder überschreiben noch auditieren.
        if (!state) return null;
        await evidence.record(tx, {
          tenantId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'workflow.instance.auto_resume',
          resourceType: 'workflow_instance',
          resourceId: candidate.id,
          after: state,
        });
        return state;
      });
      if (after) resumed += 1;
      else unchanged += 1;
    } catch (error) {
      // Eine fehlerhafte Instanz blockiert die übrigen nicht; der nächste Lauf
      // versucht sie erneut.
      failed += 1;
      log.error(
        {
          component: 'workflow-auto-resume',
          tenantId,
          workflowId: candidate.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'workflow-auto-resume: Fortsetzen fehlgeschlagen',
      );
    }
  }
  const result = { due: due.length, resumed, unchanged, moduleDisabled, failed };
  if (due.length > 0) log.info(result, 'workflow-auto-resume: done');
  return result;
}

export const workflowAutoResumeWorker = createWorker<Record<string, never>>(
  JOB_QUEUES.workflowAutoResume.name,
  async () => {
    await runWorkflowAutoResume();
  },
  { connection, concurrency: 1 },
);
