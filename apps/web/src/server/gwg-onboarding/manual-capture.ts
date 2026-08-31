import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import {
  copyGwgSnapshotTx,
  GWG_SNAPSHOT_COPY_INCLUDE,
  lockGwgCheckLifecycleTx,
  startFreshGwgReviewTx,
} from '@/server/gwg/reverification';
import { cancelOpenGwgInvitesTx } from './invite-lifecycle';

/** GWG-SELF-ONBOARDING-001 / GWG-ACTIVATION-GATE-001: switch collection channel, never approve. */
export async function startManualGwgCaptureTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    staffId: string;
  },
): Promise<{ checkId: string; reused: boolean; cancelledInviteCount: number }> {
  await lockGwgCheckLifecycleTx(tx, input);
  const client = await tx.client.findFirst({
    where: { id: input.clientId, tenantId: input.tenantId },
    select: { id: true },
  });
  if (!client) throw new ActionError('Mandant nicht gefunden.');
  const latest = await tx.gwgCheck.findFirst({
    where: { clientId: input.clientId, tenantId: input.tenantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: GWG_SNAPSHOT_COPY_INCLUDE,
  });
  const reused = Boolean(
    latest && ['DRAFT', 'IN_REVIEW'].includes(latest.status) && !latest.destroyedAt,
  );
  let checkId: string;
  if (reused && latest) {
    // Merely opening staff capture must not erase data, risk answers or handover.
    checkId = latest.id;
  } else {
    const review = await startFreshGwgReviewTx(tx, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      predecessorCheckId: latest?.id ?? null,
      changeScope: latest ? 'ROUTINE' : 'INITIAL',
    });
    checkId = review.reviewCheckId;
    const copied = await copyGwgSnapshotTx(tx, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      targetCheckId: checkId,
      source: latest,
    });
    await evidenceService.record(tx, {
      tenantId: input.tenantId,
      actorType: 'STAFF',
      actorId: input.staffId,
      action: 'gwg.check.open',
      resourceType: 'gwg_check',
      resourceId: checkId,
      after: {
        clientId: input.clientId,
        source: 'MANUAL_ONBOARDING',
        predecessorCheckId: latest?.id ?? null,
        ...copied,
        clientDeactivated: review.clientDeactivated,
      },
    });
  }
  const openInvites = await tx.gwgOnboardingInvite.findMany({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: { in: ['PENDING', 'STARTED'] },
    },
    select: { id: true },
  });
  const cancelledInviteCount = await cancelOpenGwgInvitesTx(tx, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    cancelledByStaff: input.staffId,
    cancellationReason: 'Erfassung durch Kanzlei',
  });
  await evidenceService.record(tx, {
    tenantId: input.tenantId,
    actorType: 'STAFF',
    actorId: input.staffId,
    action: 'gwg.onboarding.manual.start',
    resourceType: 'gwg_check',
    resourceId: checkId,
    before: { openInviteIds: openInvites.map((invite) => invite.id) },
    after: { clientId: input.clientId, reused, cancelledInviteCount, collectionChannel: 'STAFF' },
  });
  return { checkId, reused, cancelledInviteCount };
}
