import { Worker } from 'bullmq';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { createWorkflowFeedbackTx } from '@taxtronik/db/workflow-feedback';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { log } from '../logger';

const evidence = new EvidenceService(new LocalTimestampAdapter());

// Fachkatalog: WORKFLOW-LIFECYCLE-001, CLIENT-FEEDBACK-001.
// The workflow row is the durable completion dispatch; no external delivery occurs.
export async function runWorkflowFeedback(now = new Date()) {
  const candidates = await prismaOwner.workflowInstance.findMany({
    where: {
      status: 'COMPLETED',
      feedbackPendingAt: { not: null, lte: now },
      feedbackProcessedAt: null,
      feedbackContactId: { not: null },
    },
    select: { id: true, tenantId: true, feedbackPendingAt: true },
    orderBy: [{ feedbackPendingAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  let invited = 0,
    processed = 0,
    failed = 0;
  for (const candidate of candidates) {
    try {
      const outcome = await withWorkerTenantContext(candidate.tenantId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM workflow_instance WHERE id=${candidate.id}::uuid FOR UPDATE`;
        const workflow = await tx.workflowInstance.findFirst({
          where: {
            id: candidate.id,
            tenantId: candidate.tenantId,
            status: 'COMPLETED',
            feedbackPendingAt: { not: null, lte: now },
            feedbackProcessedAt: null,
          },
        });
        if (!workflow?.feedbackContactId) return null;
        return createWorkflowFeedbackTx(
          tx,
          {
            tenantId: candidate.tenantId,
            staffId: workflow.startedByStaff,
            instanceId: workflow.id,
            contactId: workflow.feedbackContactId,
            automatic: true,
            now,
          },
          async (invitationId) => {
            await evidence.record(tx, {
              tenantId: candidate.tenantId,
              actorType: 'SYSTEM',
              actorId: null,
              action: 'feedback.invited',
              resourceType: 'client_interaction',
              resourceId: invitationId,
              after: { sourceId: workflow.id, automatic: true },
            });
          },
        );
      });
      if (outcome) processed += 1;
      if (outcome === 'INVITED') invited += 1;
    } catch (error) {
      failed += 1;
      // A failed candidate moves behind the rest of the queue, preventing a
      // persistent poison record from starving all subsequent completions.
      await prismaOwner.workflowInstance.updateMany({
        where: {
          id: candidate.id,
          tenantId: candidate.tenantId,
          status: 'COMPLETED',
          feedbackPendingAt: candidate.feedbackPendingAt,
          feedbackProcessedAt: null,
        },
        data: { feedbackPendingAt: new Date(now.getTime() + 5 * 60_000) },
      });
      log.warn(
        {
          component: 'workflow-feedback',
          workflowId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'feedback dispatch deferred',
      );
    }
  }
  return { processed, invited, failed };
}

export const workflowFeedbackWorker = new Worker<Record<string, never>>(
  JOB_QUEUES.workflowFeedback.name,
  async () => {
    await runWorkflowFeedback();
  },
  { connection, concurrency: 1 },
);
