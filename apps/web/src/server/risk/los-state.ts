import type { TxClient } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';

export const LOS_PENDING_KEY = 'quantenlos.pending';
export const LOS_START_KEY = 'quantenlos.start';

export class LosStateConflictError extends Error {
  constructor() {
    super(
      'Der Quantenlos-Auftrag wurde bereits bearbeitet oder ein anderer Auftrag ist offen. Bitte die Seite neu laden.',
    );
    this.name = 'LosStateConflictError';
  }
}

// TCMS-SAMPLE-PROOF-001: only short database transactions hold this lock.
async function lockLosStateTx(tx: TxClient, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}::text || ':quantenlos-state', 0))`;
}

export async function reserveLosStartTx(
  tx: TxClient,
  tenantId: string,
  start: object,
  actorId: string,
) {
  await lockLosStateTx(tx, tenantId);
  if (
    (await readTenantSettingValue(tx, tenantId, LOS_PENDING_KEY)) !== undefined ||
    (await readTenantSettingValue(tx, tenantId, LOS_START_KEY)) !== undefined
  )
    throw new LosStateConflictError();
  await writeTenantSettingValue(tx, {
    tenantId,
    key: LOS_START_KEY,
    value: start,
    updatedBy: actorId,
  });
}

/** Preserve a received response before local finalization, for audited recovery. */
export async function saveLosStartResponseTx(
  tx: TxClient,
  tenantId: string,
  start: { attemptId: string },
  response: object,
) {
  await lockLosStateTx(tx, tenantId);
  const current = await readTenantSettingValue(tx, tenantId, LOS_START_KEY);
  if (
    !current ||
    typeof current !== 'object' ||
    !('attemptId' in current) ||
    current.attemptId !== start.attemptId
  ) {
    throw new LosStateConflictError();
  }
  await writeTenantSettingValue(tx, {
    tenantId,
    key: LOS_START_KEY,
    value: { ...start, engineResponse: response },
  });
}

/** Consume only the exact job/frame read before engine I/O, in the task/audit transaction. */
export async function claimLosPendingTx(tx: TxClient, tenantId: string, pending: object) {
  await lockLosStateTx(tx, tenantId);
  const claimed = await tx.tenantSetting.deleteMany({
    where: { tenantId, key: LOS_PENDING_KEY, value: { equals: pending as Prisma.InputJsonValue } },
  });
  if (claimed.count !== 1) throw new LosStateConflictError();
}

/** Finish/abandon only this reservation; a rollback restores it along with all side effects. */
export async function claimLosStartTx(
  tx: TxClient,
  tenantId: string,
  attemptId: string,
  expectedStart?: object,
) {
  await lockLosStateTx(tx, tenantId);
  const claimed = await tx.tenantSetting.deleteMany({
    where: {
      tenantId,
      key: LOS_START_KEY,
      value: expectedStart
        ? { equals: expectedStart as Prisma.InputJsonValue }
        : { path: ['attemptId'], equals: attemptId },
    },
  });
  if (
    claimed.count !== 1 ||
    (await readTenantSettingValue(tx, tenantId, LOS_PENDING_KEY)) !== undefined
  ) {
    throw new LosStateConflictError();
  }
}
