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
