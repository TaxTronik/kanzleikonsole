// =============================================================================
// workflow-n8n-dispatch — Reconciler der dauerhaft gespeicherten n8n-Handoffs
// von Workflow-Schritten (WORKFLOW-LIFECYCLE-001).
//
// F-11: Ein Handoff endet in einem von drei Zuständen:
//   - PENDING/DUPLICATE: an die Outbox übergeben → Dispatch abgeschlossen.
//   - SKIPPED/UNROUTED/INVALID_EVENT: das Ereignis wird nicht zugestellt (nicht
//     abonniert, n8n aus, Route inaktiv, Event unzulässig). Der Enqueue-Kern
//     liefert für denselben Dedupe-Schlüssel dauerhaft dasselbe Ergebnis; die
//     Zeile wird deshalb endgültig verbucht (settledStatus) statt jede Minute
//     erneut versucht. Vorher belegten 100 solcher Zeilen den ganzen Lauf, und
//     echte Fehler wurden nie mehr nachgezogen. Ausnahme UNROUTED: hat ein Admin
//     das Outbox-Ereignis neu zugeordnet (Replay), nimmt der Reconciler die
//     Zeile wieder auf; der Dedupe-Read bestätigt den Handoff dann als
//     DUPLICATE und schließt einen n8n-Schritt wie bisher ab.
//   - WRITE_FAILED: technischer Fehler → erneuter Versuch mit begrenztem
//     exponentiellem Abstand (nextAttemptAt), ohne Obergrenze der Versuche.
// =============================================================================

import { createWorker } from '../worker-factory';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import type { N8nEventName } from '@taxtronik/n8n-shared';
import type { N8nEnqueueStatus } from '@taxtronik/n8n-shared/outbox-enqueue';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { emitN8nEventFromWorker } from '../n8n-emit';
import { log } from '../logger';
import { withWorkerTenantContext } from '../tenant-context';

const CLAIM_STALE_MS = 5 * 60_000;
const BATCH_SIZE = 100;
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;
const evidence = new EvidenceService(new LocalTimestampAdapter());

/** Endgültige Handoff-Ausgänge ohne Zustellung (CHECK der Spalte settled_status). */
export const SETTLED_HANDOFF_STATUSES = ['SKIPPED', 'UNROUTED', 'INVALID_EVENT'] as const;
export type SettledHandoffStatus = (typeof SETTLED_HANDOFF_STATUSES)[number];

export function isSettledHandoff(status: N8nEnqueueStatus): status is SettledHandoffStatus {
  return (SETTLED_HANDOFF_STATUSES as readonly string[]).includes(status);
}

/** Abstand nach dem n-ten fehlgeschlagenen Versuch: 1, 2, 4 … Minuten, höchstens 1 h. */
export function writeFailedRetryDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 10);
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent);
}

const CANDIDATE_SELECT = {
  id: true,
  itemId: true,
  tenantId: true,
  actorStaffId: true,
  event: true,
  payload: true,
  attemptCount: true,
  item: { select: { kind: true } },
} as const;

interface DispatchCandidate {
  id: string;
  itemId: string;
  tenantId: string;
  actorStaffId: string;
  event: string;
  payload: unknown;
  attemptCount: number;
  item: { kind: string };
}

/** 'unclaimed': ein anderer Lauf hält die Zeile; 'lost': nach dem Claim überholt. */
type CandidateOutcome = 'enqueued' | 'settled' | 'failed' | 'lost' | 'unclaimed';

async function loadReplayedUnroutedCandidates(staleBefore: Date): Promise<DispatchCandidate[]> {
  // Nur UNROUTED-Zeilen, deren Outbox-Ereignis UNROUTED verlassen hat (Replay
  // oder Admin-Abschluss); Teilindex wf_n8n_dispatch_unrouted_idx.
  const rows = await prismaOwner.$queryRaw<Array<{ id: string }>>`
    SELECT d."id"
      FROM "workflow_n8n_dispatch" d
      JOIN "n8n_outbox" o ON o."id" = d."outbox_id"
     WHERE d."enqueued_at" IS NULL
       AND d."settled_status" = 'UNROUTED'
       AND o."status" <> 'UNROUTED'
       AND (d."claimed_at" IS NULL OR d."claimed_at" <= ${staleBefore})
     ORDER BY d."created_at", d."id"
     LIMIT ${BATCH_SIZE}
  `;
  if (rows.length === 0) return [];
  return prismaOwner.workflowN8nDispatch.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: CANDIDATE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

async function processCandidate(
  candidate: DispatchCandidate,
  staleBefore: Date,
  replay: boolean,
): Promise<CandidateOutcome> {
  const claimedAt = new Date();
  const claim = await prismaOwner.workflowN8nDispatch.updateMany({
    where: {
      id: candidate.id,
      enqueuedAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
      ...(replay ? { settledStatus: 'UNROUTED' } : { settledAt: null }),
    },
    data: { claimedAt },
  });
  if (claim.count !== 1) return 'unclaimed';

  const payload =
    candidate.payload && typeof candidate.payload === 'object' && !Array.isArray(candidate.payload)
      ? (candidate.payload as Record<string, unknown>)
      : {};
  const result = await emitN8nEventFromWorker(candidate.event as N8nEventName, payload, {
    tenantId: candidate.tenantId,
    dedupeKey: `workflow-dispatch:${candidate.id}`,
  });
  const lastError = (result.error ?? result.status).slice(0, 2000);

  if (isSettledHandoff(result.status)) {
    const settled = await prismaOwner.workflowN8nDispatch.updateMany({
      where: { id: candidate.id, enqueuedAt: null, claimedAt },
      data: {
        claimedAt: null,
        attemptCount: { increment: 1 },
        lastError,
        nextAttemptAt: null,
        settledStatus: result.status,
        settledAt: new Date(),
        ...(result.eventId ? { outboxId: result.eventId } : {}),
      },
    });
    return settled.count === 1 ? 'settled' : 'lost';
  }

  if (result.status !== 'PENDING' && result.status !== 'DUPLICATE') {
    const attempt = candidate.attemptCount + 1;
    const failed = await prismaOwner.workflowN8nDispatch.updateMany({
      where: { id: candidate.id, enqueuedAt: null, claimedAt },
      data: {
        claimedAt: null,
        attemptCount: { increment: 1 },
        lastError,
        nextAttemptAt: new Date(Date.now() + writeFailedRetryDelayMs(attempt)),
        // Ein wieder aufgenommenes UNROUTED wird zur normalen offenen Zeile.
        settledStatus: null,
        settledAt: null,
      },
    });
    return failed.count === 1 ? 'failed' : 'lost';
  }

  const done = await withWorkerTenantContext(candidate.tenantId, async (tx) => {
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
        nextAttemptAt: null,
        settledStatus: null,
        settledAt: null,
      },
    });
    if (dispatchDone.count !== 1) return dispatchDone;

    if (candidate.item.kind === 'N8N_TRIGGER') {
      const itemDone = await tx.workflowItem.updateMany({
        where: { id: candidate.itemId, kind: 'N8N_TRIGGER', doneAt: null },
        data: { doneAt: new Date(), doneByStaff: candidate.actorStaffId },
      });
      if (itemDone.count === 1) {
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
  return done.count === 1 ? 'enqueued' : 'lost';
}

export async function runWorkflowN8nDispatch(now = new Date()): Promise<{
  claimed: number;
  enqueued: number;
  settled: number;
  failed: number;
}> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const due = await prismaOwner.workflowN8nDispatch.findMany({
    where: {
      enqueuedAt: null,
      settledAt: null,
      AND: [
        { OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        {
          item: {
            is: {
              OR: [{ kind: { not: 'CLIENT_EMAIL' } }, { doneAt: { not: null } }],
            },
          },
        },
      ],
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });
  const replayed = await loadReplayedUnroutedCandidates(staleBefore);

  const counts = { claimed: 0, enqueued: 0, settled: 0, failed: 0 };
  const work: Array<[DispatchCandidate, boolean]> = [
    ...due.map((candidate): [DispatchCandidate, boolean] => [candidate, false]),
    ...replayed.map((candidate): [DispatchCandidate, boolean] => [candidate, true]),
  ];
  for (const [candidate, replay] of work) {
    const outcome = await processCandidate(candidate, staleBefore, replay);
    if (outcome === 'unclaimed') continue;
    counts.claimed += 1;
    if (outcome !== 'lost') counts[outcome] += 1;
  }

  log.info(
    {
      component: 'workflow-n8n-dispatch',
      candidates: due.length,
      replayedUnrouted: replayed.length,
      ...counts,
    },
    'workflow n8n dispatch reconciliation finished',
  );
  return counts;
}

export const workflowN8nDispatchWorker = createWorker<Record<string, never>>(
  JOB_QUEUES.workflowN8nDispatch.name,
  async () => {
    await runWorkflowN8nDispatch();
  },
  { connection, concurrency: 1 },
);
