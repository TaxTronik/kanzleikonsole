// Fachkatalog: WORKFLOW-LIFECYCLE-001
// F-11: SKIPPED/UNROUTED/INVALID_EVENT werden endgültig verbucht statt jede
// Minute erneut versucht; WRITE_FAILED bleibt mit begrenztem Abstand offen;
// ein nach Admin-Replay nicht mehr UNROUTED-Ereignis wird wieder aufgenommen.
// Die Abfragesemantik mit >100 verworfenen Zeilen belegt
// workflow-n8n-dispatch-db.test.ts gegen PostgreSQL.
// S-01: Der Owner sucht nur ID und Tenant fälliger Handoffs; Laden, Claim,
// Verbuchung und Abschluss laufen im SYSTEM-Kontext des Tenants
// (workflow-n8n-dispatch-app-role-db.test.ts belegt die App-Rolle).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  itemUpdateMany: vi.fn(),
  withSystemContext: vi.fn(),
  contexts: [] as string[],
  byId: new Map<string, unknown>(),
  evidenceRecord: vi.fn(),
  emit: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    workflowN8nDispatch: { findMany: h.findMany },
    $queryRaw: h.queryRaw,
  },
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: h.withSystemContext }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../n8n-emit', () => ({ emitN8nEventFromWorker: h.emit }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.evidenceRecord;
  },
  LocalTimestampAdapter: class {},
}));

import { runWorkflowN8nDispatch, writeFailedRetryDelayMs } from '../workflow-n8n-dispatch';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const CANDIDATE = {
  id: 'dispatch-1',
  itemId: 'item-1',
  tenantId: 'tenant-1',
  actorStaffId: 'staff-1',
  event: 'workflow.step.email.sent',
  payload: { itemId: 'item-1' },
  attemptCount: 0,
  item: { kind: 'CLIENT_EMAIL' },
};

/** Fällige (oder nach Replay wieder aufgenommene) Handoffs: der Owner liefert nur ID und Tenant. */
function schedule(candidates: Array<typeof CANDIDATE>, mode: 'due' | 'replay' = 'due') {
  for (const candidate of candidates) h.byId.set(candidate.id, candidate);
  const rows = candidates.map(({ id, tenantId }) => ({ id, tenantId }));
  if (mode === 'due') h.findMany.mockResolvedValue(rows);
  else h.queryRaw.mockResolvedValue(rows);
}

describe('workflow n8n dispatch reconciliation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h.contexts.length = 0;
    h.byId.clear();
    h.findMany.mockResolvedValue([]);
    h.queryRaw.mockResolvedValue([]);
    h.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => h.byId.get(where.id) ?? null,
    );
    h.updateMany.mockResolvedValue({ count: 1 });
    h.itemUpdateMany.mockResolvedValue({ count: 1 });
    h.withSystemContext.mockImplementation(
      async (tenantId: string, run: (tx: unknown) => Promise<unknown>) => {
        h.contexts.push(tenantId);
        return run({
          workflowN8nDispatch: { findUnique: h.findUnique, updateMany: h.updateMany },
          workflowItem: { updateMany: h.itemUpdateMany },
        });
      },
    );
    h.evidenceRecord.mockResolvedValue(undefined);
    h.emit.mockResolvedValue({ eventId: 'outbox-1', status: 'PENDING', deliveryCount: 1 });
  });

  it('scannt nur fällige, nicht endgültig verbuchte Zeilen; CLIENT_EMAIL erst nach doneAt', async () => {
    await runWorkflowN8nDispatch(NOW);

    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enqueuedAt: null,
          settledAt: null,
          AND: [
            {
              OR: [
                { claimedAt: null },
                { claimedAt: { lte: new Date('2026-08-23T11:55:00.000Z') } },
              ],
            },
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }] },
            {
              item: {
                is: {
                  OR: [{ kind: { not: 'CLIENT_EMAIL' } }, { doneAt: { not: null } }],
                },
              },
            },
          ],
        },
        select: { id: true, tenantId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      }),
    );
  });

  it('lädt jeden Handoff erst im SYSTEM-Kontext seines Tenants', async () => {
    schedule([CANDIDATE]);
    h.findMany.mockResolvedValue([
      { id: 'dispatch-1', tenantId: 'tenant-1' },
      { id: 'dispatch-gone', tenantId: 'tenant-2' },
    ]);

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toMatchObject({ claimed: 1 });

    expect(h.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dispatch-gone' } }),
    );
    expect(new Set(h.contexts)).toEqual(new Set(['tenant-1', 'tenant-2']));
    // Eine inzwischen verschwundene Zeile wird weder beansprucht noch übergeben.
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it('WRITE_FAILED bleibt offen und wird mit wachsendem Abstand erneut versucht', async () => {
    schedule([{ ...CANDIDATE, attemptCount: 2 }]);
    h.emit.mockResolvedValue({
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'database unavailable',
    });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 0,
      settled: 0,
      failed: 1,
    });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'dispatch-1', enqueuedAt: null, claimedAt: NOW },
      data: {
        claimedAt: null,
        attemptCount: { increment: 1 },
        lastError: 'database unavailable',
        // dritter Versuch → 4 Minuten
        nextAttemptAt: new Date(NOW.getTime() + 4 * 60_000),
        settledStatus: null,
        settledAt: null,
      },
    });
  });

  it('begrenzt den Abstand nach Schreibfehlern auf eine Stunde', () => {
    expect([1, 2, 3, 6, 7, 50].map(writeFailedRetryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
    expect(writeFailedRetryDelayMs(0)).toBe(60_000);
  });

  it.each(['UNROUTED', 'SKIPPED'] as const)(
    'verbucht N8N_TRIGGER bei %s endgültig und schließt das Item nicht ab',
    async (status) => {
      schedule([{ ...CANDIDATE, item: { kind: 'N8N_TRIGGER' } }]);
      h.emit.mockResolvedValue({
        eventId: 'outbox-1',
        status,
        deliveryCount: status === 'SKIPPED' ? 1 : 0,
        error: 'Keine zustellbare Route',
      });

      await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
        claimed: 1,
        enqueued: 0,
        settled: 1,
        failed: 0,
      });
      expect(h.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'dispatch-1', enqueuedAt: null, claimedAt: NOW },
        data: {
          claimedAt: null,
          attemptCount: { increment: 1 },
          lastError: 'Keine zustellbare Route',
          nextAttemptAt: null,
          settledStatus: status,
          settledAt: NOW,
          outboxId: 'outbox-1',
        },
      });
      // Claim und Verbuchung, aber kein Abschluss des Items.
      expect(h.updateMany).toHaveBeenCalledTimes(2);
      expect(h.itemUpdateMany).not.toHaveBeenCalled();
      expect(h.evidenceRecord).not.toHaveBeenCalled();
    },
  );

  it('verbucht ein unzulässiges Event endgültig ohne Outbox-Bezug', async () => {
    schedule([CANDIDATE]);
    h.emit.mockResolvedValue({
      eventId: null,
      status: 'INVALID_EVENT',
      deliveryCount: 0,
      error: "Event 'x' ist nicht freigegeben",
    });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toMatchObject({ settled: 1, failed: 0 });
    const data = h.updateMany.mock.calls.at(-1)![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ settledStatus: 'INVALID_EVENT', settledAt: NOW });
    expect(data).not.toHaveProperty('outboxId');
  });

  it('behandelt einen deduplizierten Outbox-Eintrag als erfolgreichen Handoff', async () => {
    schedule([CANDIDATE]);
    h.emit.mockResolvedValue({
      eventId: 'outbox-existing',
      status: 'DUPLICATE',
      deliveryCount: 1,
    });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      settled: 0,
      failed: 0,
    });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'dispatch-1',
        enqueuedAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lte: new Date('2026-08-23T11:55:00.000Z') } }],
        settledAt: null,
      },
      data: { claimedAt: NOW },
    });
    expect(h.emit).toHaveBeenCalledWith(CANDIDATE.event, CANDIDATE.payload, {
      tenantId: 'tenant-1',
      dedupeKey: 'workflow-dispatch:dispatch-1',
    });
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          enqueuedAt: expect.any(Date),
          outboxId: 'outbox-existing',
          nextAttemptAt: null,
          settledStatus: null,
          settledAt: null,
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
      schedule([
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
        settled: 0,
        failed: 0,
      });

      expect(h.withSystemContext).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(new Set(h.contexts)).toEqual(new Set(['tenant-1']));
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
    schedule([{ ...CANDIDATE, item: { kind: 'N8N_TRIGGER' } }]);
    h.itemUpdateMany.mockResolvedValue({ count: 0 });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      settled: 0,
      failed: 0,
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });

  it('nimmt UNROUTED nach Admin-Replay wieder auf und schließt den Schritt ab', async () => {
    schedule([{ ...CANDIDATE, item: { kind: 'N8N_TRIGGER' } }], 'replay');
    h.emit.mockResolvedValue({ eventId: 'outbox-1', status: 'DUPLICATE', deliveryCount: 1 });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      settled: 0,
      failed: 0,
    });
    expect(h.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dispatch-1' } }),
    );
    // Der Claim verlangt weiterhin den UNROUTED-Endzustand.
    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'dispatch-1',
        enqueuedAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lte: new Date('2026-08-23T11:55:00.000Z') } }],
        settledStatus: 'UNROUTED',
      },
      data: { claimedAt: NOW },
    });
    expect(h.itemUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('zählt eine von einem anderen Lauf gehaltene Zeile nicht', async () => {
    schedule([CANDIDATE]);
    h.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(runWorkflowN8nDispatch(NOW)).resolves.toEqual({
      claimed: 0,
      enqueued: 0,
      settled: 0,
      failed: 0,
    });
    expect(h.emit).not.toHaveBeenCalled();
  });
});
