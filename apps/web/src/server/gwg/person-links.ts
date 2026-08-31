import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, accessibleClientsWhereFor, assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { canonicalPersonPair } from './control-list-model';
import { lockGwgCheckLifecycleTx } from './reverification';

/** GWG-PERSON-LINKS-001: authorize both local people; no whole-group mutations. */
export async function changeGwgPersonLinkTx(
  tx: TxClient,
  session: StaffSession,
  input: { left: string; right: string; remove: boolean },
) {
  if (input.left === input.right)
    throw new ActionError('Bitte zwei unterschiedliche Personen auswählen.');
  const [fromAnchorId, toAnchorId] = canonicalPersonPair(input.left, input.right);
  const access = await accessibleClientsWhereFor(tx, session);
  const anchors = await tx.gwgPersonAnchor.findMany({
    where: {
      id: { in: [fromAnchorId, toAnchorId] },
      client: { AND: [access, { anonymizedAt: null }] },
    },
    select: { id: true, clientId: true, naturalClientId: true },
  });
  if (anchors.length !== 2) throw new ActionError('Die Personenverknüpfung ist nicht verfügbar.');
  for (const anchor of [...anchors].sort((a, b) => a.clientId.localeCompare(b.clientId))) {
    await assertClientAccessTx(tx, session, anchor.clientId);
    await lockGwgCheckLifecycleTx(tx, {
      tenantId: session.user.tenantId,
      clientId: anchor.clientId,
    });
    const latest = await tx.gwgCheck.findFirst({
      where: { clientId: anchor.clientId, destroyedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        client: { select: { anonymizedAt: true, kind: true } },
        beneficialOwners: { where: { personAnchorId: anchor.id }, select: { id: true } },
        representatives: { where: { personAnchorId: anchor.id }, select: { id: true } },
      },
    });
    if (
      !latest ||
      latest.client.anonymizedAt ||
      !(
        latest.beneficialOwners.length ||
        latest.representatives.length ||
        (anchor.naturalClientId === anchor.clientId && latest.client.kind === 'NATPERS')
      )
    ) {
      throw new ActionError('Die Personenansicht hat sich geändert. Bitte neu laden.');
    }
  }
  if (anchors[0]!.clientId === anchors[1]!.clientId)
    throw new ActionError('Bitte Personen aus zwei unterschiedlichen Mandanten auswählen.');
  const existing = await tx.gwgPersonLink.findUnique({
    where: { fromAnchorId_toAnchorId: { fromAnchorId, toAnchorId } },
  });
  if (input.remove) {
    if (!existing) return;
    await tx.gwgPersonLink.delete({ where: { id: existing.id } });
  } else {
    if (existing) return;
    await tx.gwgPersonLink.create({
      data: {
        tenantId: session.user.tenantId,
        fromAnchorId,
        toAnchorId,
        createdBy: session.user.staffId,
      },
    });
  }
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: input.remove ? 'gwg.person.link.remove' : 'gwg.person.link.add',
    resourceType: 'gwg_person_anchor',
    resourceId: fromAnchorId,
    after: { fromAnchorId, toAnchorId, clientIds: anchors.map((anchor) => anchor.clientId) },
  });
}
