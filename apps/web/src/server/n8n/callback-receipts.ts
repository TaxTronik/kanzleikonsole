import { createHash } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';
import { prismaOwner } from '@/server/db/prisma-owner';

export const N8N_CALLBACK_OPERATIONS = {
  inboundMail: 'request-inbound',
  researchResult: 'research-result',
} as const;

export type N8nCallbackOperation =
  (typeof N8N_CALLBACK_OPERATIONS)[keyof typeof N8N_CALLBACK_OPERATIONS];

export interface N8nCallbackReceiptKey {
  tenantId: string;
  connectionId: string;
  requestId: string;
  operation: N8nCallbackOperation;
}

export class N8nCallbackReceiptConflictError extends Error {
  readonly code = 'N8N_CALLBACK_RECEIPT_CONFLICT';

  constructor() {
    super('callback request id belongs to another operation');
    this.name = 'N8nCallbackReceiptConflictError';
  }
}

function requestIdHash(requestId: string): string {
  return createHash('sha256').update(requestId, 'utf8').digest('hex');
}

/**
 * Beansprucht eine Callback-ID innerhalb der laufenden Fachtransaktion.
 * createMany(skipDuplicates) wird als INSERT .. ON CONFLICT DO NOTHING
 * ausgeführt: parallele Transaktionen warten am Unique-Key. Eine sichtbare
 * bestehende Zeile stammt daher immer aus einer vollständig committeten
 * früheren Ausführung.
 */
export async function claimN8nCallbackReceipt(
  tx: TxClient,
  key: N8nCallbackReceiptKey,
): Promise<{ duplicate: false } | { duplicate: true; resultId: string | null }> {
  const hash = requestIdHash(key.requestId);
  const inserted = await tx.n8nCallbackReceipt.createMany({
    data: {
      tenantId: key.tenantId,
      connectionId: key.connectionId,
      requestIdHash: hash,
      operation: key.operation,
    },
    skipDuplicates: true,
  });
  if (inserted.count === 1) return { duplicate: false };

  const existing = await tx.n8nCallbackReceipt.findUnique({
    where: {
      connectionId_requestIdHash: {
        connectionId: key.connectionId,
        requestIdHash: hash,
      },
    },
    select: { tenantId: true, operation: true, resultId: true },
  });
  if (!existing || existing.tenantId !== key.tenantId || existing.operation !== key.operation) {
    throw new N8nCallbackReceiptConflictError();
  }

  return { duplicate: true, resultId: existing.resultId };
}

/** Speichert die fachliche Ergebnis-ID noch in derselben Fachtransaktion. */
export async function setN8nCallbackReceiptResult(
  tx: TxClient,
  key: N8nCallbackReceiptKey,
  resultId: string,
): Promise<void> {
  await tx.n8nCallbackReceipt.update({
    where: {
      connectionId_requestIdHash: {
        connectionId: key.connectionId,
        requestIdHash: requestIdHash(key.requestId),
      },
    },
    data: { resultId },
  });
}

/**
 * Read-only Crash-Recovery-Check für einen Redis-IN_PROGRESS-Marker. Die
 * Zeile kann erst nach Commit sichtbar werden und ist damit eine belastbare
 * Aussage, dass der Side Effect abgeschlossen ist.
 */
export async function getCompletedN8nCallbackReceipt(
  key: N8nCallbackReceiptKey,
): Promise<{ resultId: string | null } | null> {
  const existing = await prismaOwner.n8nCallbackReceipt.findUnique({
    where: {
      connectionId_requestIdHash: {
        connectionId: key.connectionId,
        requestIdHash: requestIdHash(key.requestId),
      },
    },
    select: { tenantId: true, operation: true, resultId: true },
  });
  if (existing?.tenantId !== key.tenantId || existing.operation !== key.operation) return null;
  return { resultId: existing.resultId };
}

export async function hasCompletedN8nCallbackReceipt(key: N8nCallbackReceiptKey): Promise<boolean> {
  return (await getCompletedN8nCallbackReceipt(key)) !== null;
}
