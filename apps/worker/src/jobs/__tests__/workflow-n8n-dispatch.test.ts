import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  dispatchUpdateMany: vi.fn(),
  itemUpdateMany: vi.fn(),
  withWorkerTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  emit: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    workflowN8nDispatch: { findMany: h.findMany, updateMany: h.updateMany },
  },
}));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../n8n-emit', () => ({ emitN8nEventFromWorker: h.emit }));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: h.withWorkerTenantContext,
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.evidenceRecord;
  },
  LocalTimestampAdapter: class {},
}));

import { runWorkflowN8nDispatch } from '../workflow-n8n-dispatch';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const CANDIDATE = {
  id: 'dispatch-1',
  itemId: 'item-1',
  tenantId: 'tenant-1',
  actorStaffId: 'staff-1',
  event: 'workflow.step.email.sent',
  payload: { itemId: 'item-1' },
  item: { kind: 'CLIENT_EMAIL' },
};

describe('workflow n8n dispatch reconciliation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.findMany.mockResolvedValue([]);
    h.updateMany.mockResolvedValue({ count: 1 });
    h.dispatchUpdateMany.mockResolvedValue({ count: 1 });
    h.itemUpdateMany.mockResolvedValue({ count: 1 });
    h.withWorkerTenantContext.mockImplementation(
      async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
        run({
          workflowN8nDispatch: { updateMany: h.dispatchUpdateMany },
          workflowItem: { updateMany: h.itemUpdateMany },
        }),
    );
    h.evidenceRecord.mockResolvedValue(undefined);
    h.emit.mockResolvedValue({ eventId: 'outbox-1', status: 'PENDING', deliveryCount: 1 });
  });

  it('scannt CLIENT_EMAIL erst nach doneAt und andere Kinds sofort', async () => {
    await runWorkflowN8nDispatch(NOW);

    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enqueuedAt: null,
          AND: [
            {
              OR: [
                { claimedAt: null },
                { claimedAt: { lte: new Date('2026-08-23T11:55:00.000Z') } },
              ],
            },
            {
              item: {
                is: {
                  OR: [{ kind: { not: 'CLIENT_EMAIL' } }, { doneAt: { not: null } }],
                },
              },
            },
          ],
        },
      }),
    );
  });

  it('lässt WRITE_FAILED pending und retrybar', async () => {
    h.findMany.mockResolvedValue([CANDIDATE]);
    h.emit.mockResolvedValue({
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'database unavailable',
    });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      failed: 1,
    });
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          claimedAt: null,
          attemptCount: { increment: 1 },
          lastError: 'database unavailable',
        },
      }),
    );
  });

  it('behandelt einen deduplizierten Outbox-Eintrag als erfolgreichen Handoff', async () => {
    h.findMany.mockResolvedValue([CANDIDATE]);
    h.emit.mockResolvedValue({
      eventId: 'outbox-existing',
      status: 'DUPLICATE',
      deliveryCount: 1,
    });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      failed: 0,
    });
    expect(h.emit).toHaveBeenCalledWith(CANDIDATE.event, CANDIDATE.payload, {
      tenantId: 'tenant-1',
      dedupeKey: 'workflow-dispatch:dispatch-1',
    });
    expect(h.dispatchUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          enqueuedAt: expect.any(Date),
          outboxId: 'outbox-existing',
        }),
      }),
    );
  });

  it.each([
    { status: 'PENDING', eventId: 'outbox-1' },
    { status: 'DUPLICATE', eventId: 'outbox-existing' },
  ])(
    'schließt N8N_TRIGGER nach $status-Handoff mit dem Staff-Snapshot atomar ab',
    async ({ status, eventId }) => {
      h.findMany.mockResolvedValue([
        {
          ...CANDIDATE,
          event: 'workflow.step.custom.trigger',
          item: { kind: 'N8N_TRIGGER' },
        },
      ]);
      h.emit.mockResolvedValue({ eventId, status, deliveryCount: 1 });

      await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
        claimed: 1,
        enqueued: 1,
        failed: 0,
      });

      expect(h.withWorkerTenantContext).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(h.itemUpdateMany).toHaveBeenCalledWith({
        where: { id: 'item-1', kind: 'N8N_TRIGGER', doneAt: null },
        data: { doneAt: expect.any(Date), doneByStaff: 'staff-1' },
      });
      expect(h.evidenceRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'tenant-1',
          actorType: 'STAFF',
          actorId: 'staff-1',
          action: 'workflow.item.execute',
          resourceType: 'workflow_item',
          resourceId: 'item-1',
          after: expect.objectContaining({
            kind: 'N8N_TRIGGER',
            markedDone: true,
            n8nOutboxId: eventId,
            n8nStatus: status,
          }),
        }),
      );
    },
  );

  it('schreibt bei verlorenem Item-CAS kein doppeltes Evidence-Event', async () => {
    h.findMany.mockResolvedValue([{ ...CANDIDATE, item: { kind: 'N8N_TRIGGER' } }]);
    h.itemUpdateMany.mockResolvedValue({ count: 0 });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      failed: 0,
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });
});
