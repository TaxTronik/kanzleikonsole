import { Worker } from 'bullmq';
import type { N8nEventName } from '@taxtronik/n8n-shared';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { emitN8nEventFromWorker } from '../n8n-emit';
import { log } from '../logger';
import { withWorkerTenantContext } from '../tenant-context';

const CLAIM_STALE_MS = 5 * 60_000;
const BATCH_SIZE = 100;
const evidence = new EvidenceService(new LocalTimestampAdapter());

export async function runWorkflowN8nDispatch(now = new Date()): Promise<{
  claimed: number;
  enqueued: number;
  failed: number;
}> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const candidates = await prismaOwner.workflowN8nDispatch.findMany({
    where: {
      enqueuedAt: null,
      AND: [
        { OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }] },
        {
          item: {
            is: {
              OR: [{ kind: { not: 'CLIENT_EMAIL' } }, { doneAt: { not: null } }],
            },
          },
        },
      ],
    },
    select: {
      id: true,
      itemId: true,
      tenantId: true,
      actorStaffId: true,
      event: true,
      payload: true,
      item: { select: { kind: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });

  let claimed = 0;
  let enqueued = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimedAt = new Date();
    const claim = await prismaOwner.workflowN8nDispatch.updateMany({
      where: {
        id: candidate.id,
        enqueuedAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
      },
      data: { claimedAt },
    });
    if (claim.count !== 1) continue;
    claimed += 1;

    const payload =
      candidate.payload &&
      typeof candidate.payload === 'object' &&
      !Array.isArray(candidate.payload)
        ? (candidate.payload as Record<string, unknown>)
        : {};
    const result = await emitN8nEventFromWorker(candidate.event as N8nEventName, payload, {
      tenantId: candidate.tenantId,
      dedupeKey: `workflow-dispatch:${candidate.id}`,
    });
    const writeFailed = result.status === 'WRITE_FAILED' || result.status === 'INVALID_EVENT';
    const updated = writeFailed
      ? await prismaOwner.workflowN8nDispatch.updateMany({
          where: { id: candidate.id, enqueuedAt: null, claimedAt },
          data: {
            claimedAt: null,
            attemptCount: { increment: 1 },
            lastError: (result.error ?? result.status).slice(0, 2000),
          },
        })
      : await withWorkerTenantContext(candidate.tenantId, async (tx) => {
          // Dispatch-Status, fachlicher CAS-Abschluss und Audit sind atomar.
          // Nach einem Crash vor diesem Commit bleibt der Dispatch pending;
          // der nächste Lauf erhält über den stabilen Dedupe-Key DUPLICATE.
          const dispatchDone = await tx.workflowN8nDispatch.updateMany({
            where: { id: candidate.id, enqueuedAt: null, claimedAt },
            data: {
              claimedAt: null,
              enqueuedAt: new Date(),
              outboxId: result.eventId,
              attemptCount: { increment: 1 },
              lastError: null,
            },
          });
          if (dispatchDone.count !== 1) return dispatchDone;

          if (candidate.item.kind === 'N8N_TRIGGER') {
            const done = await tx.workflowItem.updateMany({
              where: { id: candidate.itemId, kind: 'N8N_TRIGGER', doneAt: null },
              data: { doneAt: new Date(), doneByStaff: candidate.actorStaffId },
            });
            if (done.count === 1) {
              await evidence.record(tx, {
                tenantId: candidate.tenantId,
                actorType: 'STAFF',
                actorId: candidate.actorStaffId,
                action: 'workflow.item.execute',
                resourceType: 'workflow_item',
                resourceId: candidate.itemId,
                after: {
                  kind: 'N8N_TRIGGER',
                  markedDone: true,
                  n8nEvent: candidate.event,
                  n8nOutboxId: result.eventId,
                  n8nStatus: result.status,
                },
              });
            }
          }
          return dispatchDone;
        });
    if (updated.count !== 1) continue;
    if (writeFailed) failed += 1;
    else enqueued += 1;
  }

  log.info(
    {
      component: 'workflow-n8n-dispatch',
      candidates: candidates.length,
      claimed,
      enqueued,
      failed,
    },
    'workflow n8n dispatch reconciliation finished',
  );
  return { claimed, enqueued, failed };
}

export const workflowN8nDispatchWorker = new Worker<Record<string, never>>(
  'workflow-n8n-dispatch',
  async () => {
    await runWorkflowN8nDispatch();
  },
  { connection, concurrency: 1 },
);
