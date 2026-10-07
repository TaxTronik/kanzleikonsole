// Fachkatalog: WORKFLOW-LIFECYCLE-001
// =============================================================================
// F-11: workflow-n8n-dispatch gegen echtes PostgreSQL.
//
// Belegt die Abfragesemantik, die der Mock-Test nicht prüfen kann:
//   (1) Mehr als 100 dauerhaft verworfene Handoffs (SKIPPED) blockieren den
//       Reconciler nicht: sie werden endgültig verbucht, und ein jüngerer
//       echter Fehlerfall wird spätestens im zweiten Lauf nachgezogen. Vorher
//       holte jeder Lauf erneut dieselben 100 ältesten Zeilen.
//   (2) WRITE_FAILED wartet den Abstand ab und wird danach erneut versucht.
//   (3) Ein endgültig UNROUTED verbuchter Schritt wird nach einem Admin-Replay
//       des Outbox-Ereignisses wieder aufgenommen und abgeschlossen.
//
// Der Outbox-Handoff selbst (n8n-emit) ist eine Attrappe; Abfragen, Claims,
// Teilindizes und Status laufen gegen die migrierte Datenbank. Nur mit
// ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Eigener Tenant, der am
// Ende samt Kaskade gelöscht wird.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { N8nEnqueueResult } from '@taxtronik/n8n-shared/outbox-enqueue';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  let url: URL;
  try {
    url = new URL(process.env['DATABASE_URL'] ?? '');
  } catch {
    throw new Error('WORKER_DB_TEST requires a valid DATABASE_URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname.length < 2 ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('WORKER_DB_TEST requires a loopback PostgreSQL DATABASE_URL.');
  }
}

const h = vi.hoisted(() => ({
  emit: vi.fn(),
  record: vi.fn(),
  outcomes: new Map<string, N8nEnqueueResult>(),
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../n8n-emit', () => ({ emitN8nEventFromWorker: h.emit }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { prismaOwner } from '../../prisma-owner';
import { runWorkflowN8nDispatch } from '../workflow-n8n-dispatch';

const SKIPPED: N8nEnqueueResult = {
  eventId: null,
  status: 'SKIPPED',
  deliveryCount: 1,
  error: 'n8n nicht vollständig konfiguriert',
};
const DAY_MS = 24 * 60 * 60 * 1000;

const describeDb = enabled ? describe : describe.skip;

describeDb('F-11 workflow-n8n-dispatch against PostgreSQL', () => {
  let tenantId = '';
  let staffId = '';
  let instanceId = '';

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await prismaOwner.tenant.create({ data: { slug: `f11-${suffix}`, name: 'F-11 dispatch' } })
    ).id;
    staffId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `f11-${suffix}@example.test`,
          fullName: 'Synthetic staff',
          passwordHash: 'x',
        },
      })
    ).id;
    const client = await prismaOwner.client.create({
      data: { tenantId, name: 'Synthetic F-11 client', kind: 'JURPERS' },
    });
    instanceId = (
      await prismaOwner.workflowInstance.create({
        data: {
          tenantId,
          clientId: client.id,
          name: 'Synthetic workflow',
          startedByStaff: staffId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await prismaOwner.tenant.delete({ where: { id: tenantId } });
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    h.outcomes.clear();
    h.emit.mockImplementation(
      async (_event: string, _payload: unknown, opts: { dedupeKey: string }) =>
        h.outcomes.get(opts.dedupeKey.slice('workflow-dispatch:'.length)) ?? SKIPPED,
    );
    h.record.mockResolvedValue(undefined);
    await prismaOwner.workflowN8nDispatch.deleteMany({ where: { tenantId } });
    await prismaOwner.workflowItem.deleteMany({ where: { instanceId } });
    await prismaOwner.n8nOutbox.deleteMany({ where: { tenantId } });
  });

  /** Legt `count` N8N_TRIGGER-Schritte mit je einem offenen Dispatch an. */
  async function createDispatches(
    count: number,
    createdAt: (index: number) => Date,
    extra: { attemptCount?: number; lastError?: string } = {},
  ): Promise<Array<{ id: string; itemId: string }>> {
    const items = await prismaOwner.workflowItem.createManyAndReturn({
      data: Array.from({ length: count }, (_, index) => ({
        instanceId,
        position: index,
        title: `Synthetic n8n step ${index}`,
        kind: 'N8N_TRIGGER' as const,
      })),
      select: { id: true, position: true },
    });
    items.sort((a, b) => a.position - b.position);
    return prismaOwner.workflowN8nDispatch.createManyAndReturn({
      data: items.map((item, index) => ({
        itemId: item.id,
        tenantId,
        actorStaffId: staffId,
        event: 'workflow.step.custom.trigger',
        payload: { itemId: item.id },
        createdAt: createdAt(index),
        ...extra,
      })),
      select: { id: true, itemId: true },
    });
  }

  function emittedIds(): string[] {
    return h.emit.mock.calls.map(([, , opts]) =>
      (opts as { dedupeKey: string }).dedupeKey.slice('workflow-dispatch:'.length),
    );
  }

  it('lässt über 100 verworfene Handoffs einen echten Fehlerfall nicht verhungern', async () => {
    const base = Date.now() - 2 * DAY_MS;
    const skipped = await createDispatches(120, (index) => new Date(base + index * 1000));
    // Zuletzt angelegt: ein Dispatch, dessen Outbox-Schreiben zuvor scheiterte.
    const [failedBefore] = await createDispatches(1, () => new Date(base + DAY_MS), {
      attemptCount: 3,
      lastError: 'n8n-Outbox konnte nicht geschrieben werden',
    });
    h.outcomes.set(failedBefore!.id, {
      eventId: randomUUID(),
      status: 'PENDING',
      deliveryCount: 1,
    });

    const first = await runWorkflowN8nDispatch();
    expect(first).toMatchObject({ claimed: 100, settled: 100, enqueued: 0, failed: 0 });
    expect(emittedIds()).toEqual(skipped.slice(0, 100).map((row) => row.id));

    h.emit.mockClear();
    const second = await runWorkflowN8nDispatch();
    expect(second).toMatchObject({ claimed: 21, settled: 20, enqueued: 1 });
    expect(emittedIds()).toEqual([...skipped.slice(100).map((row) => row.id), failedBefore!.id]);

    const rows = await prismaOwner.workflowN8nDispatch.findMany({
      where: { tenantId },
      select: { id: true, settledStatus: true, settledAt: true, enqueuedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of skipped) {
      expect(byId.get(row.id)).toMatchObject({ settledStatus: 'SKIPPED', enqueuedAt: null });
      expect(byId.get(row.id)?.settledAt).toBeInstanceOf(Date);
    }
    expect(byId.get(failedBefore!.id)).toMatchObject({ settledStatus: null });
    expect(byId.get(failedBefore!.id)?.enqueuedAt).toBeInstanceOf(Date);
    const item = await prismaOwner.workflowItem.findUniqueOrThrow({
      where: { id: failedBefore!.itemId },
      select: { doneAt: true },
    });
    expect(item.doneAt).toBeInstanceOf(Date);

    // Verbuchte Zeilen werden nicht erneut angefasst.
    h.emit.mockClear();
    expect(await runWorkflowN8nDispatch()).toMatchObject({ claimed: 0 });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('wiederholt WRITE_FAILED erst nach dem Abstand', async () => {
    const [row] = await createDispatches(1, () => new Date(Date.now() - 60_000));
    h.outcomes.set(row!.id, {
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'n8n-Outbox konnte nicht geschrieben werden',
    });

    expect(await runWorkflowN8nDispatch()).toMatchObject({ claimed: 1, failed: 1 });
    const stored = await prismaOwner.workflowN8nDispatch.findUniqueOrThrow({
      where: { id: row!.id },
      select: { attemptCount: true, nextAttemptAt: true, settledAt: true, claimedAt: true },
    });
    expect(stored).toMatchObject({ attemptCount: 1, settledAt: null, claimedAt: null });
    expect(stored.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    h.emit.mockClear();
    expect(await runWorkflowN8nDispatch()).toMatchObject({ claimed: 0 });
    expect(h.emit).not.toHaveBeenCalled();

    h.outcomes.set(row!.id, { eventId: randomUUID(), status: 'PENDING', deliveryCount: 1 });
    expect(await runWorkflowN8nDispatch(new Date(Date.now() + 2 * 60_000))).toMatchObject({
      claimed: 1,
      enqueued: 1,
    });
  });

  it('nimmt einen UNROUTED verbuchten Schritt nach Admin-Replay wieder auf', async () => {
    const [row] = await createDispatches(1, () => new Date(Date.now() - 60_000));
    const outbox = await prismaOwner.n8nOutbox.create({
      data: {
        tenantId,
        event: 'workflow.step.custom.trigger',
        payload: {},
        status: 'UNROUTED',
        lastError: 'Konfigurierte n8n-Route ist nicht aktiv',
        dedupeKey: `workflow-dispatch:${row!.id}`,
      },
    });
    h.outcomes.set(row!.id, {
      eventId: outbox.id,
      status: 'UNROUTED',
      deliveryCount: 0,
      error: 'Konfigurierte n8n-Route ist nicht aktiv',
    });

    expect(await runWorkflowN8nDispatch()).toMatchObject({ settled: 1 });
    expect(
      await prismaOwner.workflowN8nDispatch.findUniqueOrThrow({
        where: { id: row!.id },
        select: { settledStatus: true, outboxId: true },
      }),
    ).toEqual({ settledStatus: 'UNROUTED', outboxId: outbox.id });

    h.emit.mockClear();
    expect(await runWorkflowN8nDispatch()).toMatchObject({ claimed: 0 });
    expect(h.emit).not.toHaveBeenCalled();

    // Admin-Replay ordnet das historische Ereignis den jetzt aktiven Routen zu.
    await prismaOwner.n8nOutbox.update({
      where: { id: outbox.id },
      data: { status: 'PENDING', lastError: null },
    });
    h.outcomes.set(row!.id, { eventId: outbox.id, status: 'DUPLICATE', deliveryCount: 1 });

    expect(await runWorkflowN8nDispatch()).toMatchObject({ claimed: 1, enqueued: 1 });
    const done = await prismaOwner.workflowN8nDispatch.findUniqueOrThrow({
      where: { id: row!.id },
      select: { settledStatus: true, settledAt: true, enqueuedAt: true },
    });
    expect(done).toMatchObject({ settledStatus: null, settledAt: null });
    expect(done.enqueuedAt).toBeInstanceOf(Date);
    const item = await prismaOwner.workflowItem.findUniqueOrThrow({
      where: { id: row!.itemId },
      select: { doneAt: true },
    });
    expect(item.doneAt).toBeInstanceOf(Date);
    expect(h.record).toHaveBeenCalledTimes(1);
  });
});
