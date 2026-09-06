import { z } from 'zod';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import {
  assertGwgEditable,
  claimCheckMutation,
} from '@/app/staff/(protected)/clients/[id]/gwg/_action-helpers';
import { evidenceService } from '@/server/container';
import { loadStructureTx } from './service';

export const BindGwgStructureInput = z.object({
  clientId: z.uuid(),
  checkId: z.uuid(),
  versionId: z.uuid(),
  expectedBindingRevision: z.number().int().nonnegative(),
  note: z.string().trim().min(10).max(3000),
  confirmed: z.literal(true),
});

export async function bindGwgStructureTx(tx: TxClient, session: StaffSession, raw: unknown) {
  const input = BindGwgStructureInput.parse(raw);
  const tenantId = session.user.tenantId;
  await assertClientAccessTx(tx, session, input.clientId);
  await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: input.clientId });
  const check = await tx.gwgCheck.findFirst({
    where: { tenantId, clientId: input.clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!check || check.id !== input.checkId || check.destroyedAt)
    throw new ActionError(
      'Nur die neueste offene GwG-Prüfung kann eine Strukturversion übernehmen.',
    );
  assertGwgEditable(check.status);
  const structure = await loadStructureTx(tx, session, input.clientId, input.versionId);
  if (!structure) throw new ActionError('Strukturversion nicht verfügbar.');
  const latest = await tx.gwgStructureBinding.findFirst({
    where: { gwgCheckId: input.checkId },
    orderBy: { revision: 'desc' },
  });
  if ((latest?.revision ?? 0) !== input.expectedBindingRevision)
    throw new ActionError('Die Strukturübernahme wurde inzwischen geändert. Bitte neu laden.');
  if (latest?.structureVersionId === input.versionId && latest.note === input.note)
    throw new ActionError('Diese Strukturversion mit diesem Vermerk ist bereits gebunden.');
  // Same mutation claim as existing GwG forms: a changed working basis needs a fresh submission.
  await claimCheckMutation(tx, {
    checkId: check.id,
    clientId: input.clientId,
    expectedStatus: check.status,
  });
  const binding = await tx.gwgStructureBinding.create({
    data: {
      tenantId,
      clientId: input.clientId,
      gwgCheckId: check.id,
      structureVersionId: structure.id,
      structureHash: structure.contentHash,
      revision: input.expectedBindingRevision + 1,
      note: input.note,
      createdBy: session.user.staffId,
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: 'gwg.structure.bind',
    resourceType: 'gwg_check',
    resourceId: check.id,
    after: {
      bindingId: binding.id,
      bindingRevision: binding.revision,
      structureVersionId: structure.id,
      structureHash: structure.contentHash,
      reviewStatus: 'DRAFT',
      manualInterpretationRequired: true,
    },
  });
  return binding.id;
}

export async function loadGwgStructureHistoryTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
) {
  await assertClientAccessTx(tx, session, clientId);
  const bindings = await tx.gwgStructureBinding.findMany({
    where: { tenantId: session.user.tenantId, clientId, destroyedAt: null },
    include: { check: { select: { id: true, status: true, createdAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const result = [];
  for (const binding of bindings) {
    if (!binding.structureVersionId) continue;
    try {
      const version = await loadStructureTx(tx, session, clientId, binding.structureVersionId);
      if (version && version.contentHash === binding.structureHash)
        result.push({ binding, version });
    } catch {
      /* No partial labels, counts or paths from inaccessible structure versions. */
    }
  }
  return result;
}
