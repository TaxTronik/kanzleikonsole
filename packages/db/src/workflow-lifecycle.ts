import type { TxClient } from './tenant-context';

/** For instance-only decisions; item writers must use lockWorkflowItemTx first. */
export async function lockWorkflowInstanceTx(tx: TxClient, instanceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workflow_instance WHERE id=${instanceId}::uuid FOR UPDATE`;
}

// Fachkatalog: WORKFLOW-LIFECYCLE-001. Match the item -> instance lock order
// used by the database triggers and external completion writers.
export async function lockWorkflowItemTx(tx: TxClient, itemId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workflow_item WHERE id=${itemId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT w.id FROM workflow_instance w
    JOIN workflow_item i ON i.instance_id=w.id WHERE i.id=${itemId}::uuid FOR UPDATE OF w`;
}

/**
 * Fachkatalog: WORKFLOW-LIFECYCLE-001. Zeitgesteuertes Fortsetzen einer pausierten
 * Instanz: schreibt nur, solange sie beim Schreiben noch PAUSED ist und ihr
 * Pausentermin erreicht ist (CAS). Eine parallele Verlängerung oder ein Abbruch
 * bleibt unangetastet (null). Der Resume-Trigger kann bei inzwischen erledigten
 * Schritten direkt COMPLETED herstellen; zurückgegeben wird der tatsächliche
 * Endstatus für die Evidence. `tenantId` bindet auch Owner-Clients ohne RLS.
 */
export async function resumeElapsedPausedWorkflowTx(
  tx: TxClient,
  input: { tenantId: string; instanceId: string; now: Date },
): Promise<{ status: string; completedAt: Date | null } | null> {
  const resumed = await tx.workflowInstance.updateMany({
    where: {
      id: input.instanceId,
      tenantId: input.tenantId,
      status: 'PAUSED',
      pausedUntil: { not: null, lte: input.now },
    },
    data: { status: 'ACTIVE', pausedUntil: null },
  });
  if (resumed.count !== 1) return null;
  return tx.workflowInstance.findUniqueOrThrow({
    where: { id: input.instanceId },
    select: { status: true, completedAt: true },
  });
}
