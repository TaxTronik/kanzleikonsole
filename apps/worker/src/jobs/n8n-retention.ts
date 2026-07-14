// =============================================================================
// n8n-Outbox-Retention
//
// Erfolgreiche/verworfene technische Zustellhistorie bleibt 90 Tage sichtbar;
// FAILED/PARTIAL für Diagnose 180 Tage. PENDING/PROCESSING wird nie gelöscht.
// Gehashte Callback-Idempotenzbelege bleiben 180 Tage erhalten.
// Kandidatensuche und Delete wiederholen dieselben Terminal-Bedingungen, damit
// ein paralleler manueller Retry nicht zwischen SELECT und DELETE verloren geht.
// =============================================================================

import { Worker } from 'bullmq';
import type { N8nOutboxStatus } from '@prisma/client';
import { connection } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

export const N8N_ROUTINE_RETENTION_DAYS = 90;
export const N8N_EXCEPTION_RETENTION_DAYS = 180;
export const N8N_CALLBACK_RECEIPT_RETENTION_DAYS = 180;
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_CLASS = 10;
const ACTIVE_DELIVERY_STATUSES = ['PENDING', 'PROCESSING'] as const;

async function cleanupClass(statuses: N8nOutboxStatus[], cutoff: Date): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch += 1) {
    const candidates = await prismaOwner.n8nOutbox.findMany({
      where: {
        status: { in: statuses },
        updatedAt: { lt: cutoff },
        deliveries: { none: { status: { in: [...ACTIVE_DELIVERY_STATUSES] } } },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
    });
    if (candidates.length === 0) break;

    const result = await prismaOwner.n8nOutbox.deleteMany({
      where: {
        id: { in: candidates.map((candidate) => candidate.id) },
        status: { in: statuses },
        updatedAt: { lt: cutoff },
        deliveries: { none: { status: { in: [...ACTIVE_DELIVERY_STATUSES] } } },
      },
    });
    deleted += result.count;
    if (result.count === 0 || candidates.length < BATCH_SIZE) break;
  }
  return deleted;
}

async function cleanupCallbackReceipts(cutoff: Date): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch += 1) {
    const candidates = await prismaOwner.n8nCallbackReceipt.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });
    if (candidates.length === 0) break;

    const result = await prismaOwner.n8nCallbackReceipt.deleteMany({
      where: {
        id: { in: candidates.map((candidate) => candidate.id) },
        createdAt: { lt: cutoff },
      },
    });
    deleted += result.count;
    if (result.count === 0 || candidates.length < BATCH_SIZE) break;
  }
  return deleted;
}

export async function runN8nRetention(now = new Date()): Promise<{
  routineDeleted: number;
  exceptionDeleted: number;
  callbackReceiptsDeleted: number;
}> {
  const dayMs = 24 * 60 * 60 * 1_000;
  const routineCutoff = new Date(now.getTime() - N8N_ROUTINE_RETENTION_DAYS * dayMs);
  const exceptionCutoff = new Date(now.getTime() - N8N_EXCEPTION_RETENTION_DAYS * dayMs);
  const callbackReceiptCutoff = new Date(
    now.getTime() - N8N_CALLBACK_RECEIPT_RETENTION_DAYS * dayMs,
  );
  const routineDeleted = await cleanupClass(['DELIVERED', 'SKIPPED', 'UNROUTED'], routineCutoff);
  const exceptionDeleted = await cleanupClass(['FAILED', 'PARTIAL'], exceptionCutoff);
  const callbackReceiptsDeleted = await cleanupCallbackReceipts(callbackReceiptCutoff);
  log.info(
    {
      routineDeleted,
      exceptionDeleted,
      callbackReceiptsDeleted,
      routineCutoff: routineCutoff.toISOString(),
      exceptionCutoff: exceptionCutoff.toISOString(),
      callbackReceiptCutoff: callbackReceiptCutoff.toISOString(),
    },
    'n8n-retention: terminal outbox rows cleaned',
  );
  return { routineDeleted, exceptionDeleted, callbackReceiptsDeleted };
}

export const n8nRetentionWorker = new Worker<Record<string, never>>(
  'n8n-retention',
  async () => {
    await runN8nRetention();
  },
  { connection, concurrency: 1 },
);
