import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { vdbTransitionAllowed } from './model';
import { isPoaExpired } from '@/server/poa/signing-snapshot';

export async function recordVdbStateTx(
  tx: TxClient,
  session: StaffSession,
  input: {
    poaId: string;
    expectedRevision: number;
    status: string;
    recordedAt: string;
    externalReference: string;
    evidenceVersionId: string | null;
    note: string;
  },
) {
  const scope = await tx.powerOfAttorney.findFirst({
    where: { id: input.poaId, tenantId: session.user.tenantId },
    select: { id: true, clientId: true },
  });
  if (!scope) throw new ActionError('Vollmacht nicht verfügbar.');
  await assertClientAccessTx(tx, session, scope.clientId);
  await tx.$queryRaw`SELECT id FROM power_of_attorney WHERE id=${scope.id}::uuid AND tenant_id=${session.user.tenantId}::uuid FOR UPDATE`;
  const poa = await tx.powerOfAttorney.findFirst({
    where: { id: scope.id, tenantId: session.user.tenantId, client: { anonymizedAt: null } },
    select: { id: true, clientId: true, status: true, validUntil: true },
  });
  if (!poa) throw new ActionError('Vollmacht nicht verfügbar.');
  const previous = await tx.vdbRecord.findFirst({
    where: { poaId: poa.id, tenantId: session.user.tenantId },
    orderBy: { revision: 'desc' },
  });
  if ((previous?.revision ?? 0) !== input.expectedRevision)
    throw new ActionError('Der Meldenachweis hat sich geändert. Bitte neu laden.');
  if (!vdbTransitionAllowed(previous?.status ?? null, input.status))
    throw new ActionError('Dieser Übergang ist nicht zulässig.');
  if (
    ['PREPARED', 'REPORTED'].includes(input.status) &&
    (poa.status !== 'SIGNED' || isPoaExpired(poa.validUntil))
  )
    throw new ActionError(
      'Für die Vorbereitung/Meldung muss die Vollmacht technisch bestätigt und nach dem erfassten Datum noch gültig sein. Das ersetzt keine Formprüfung.',
    );
  const recordedAt = new Date(input.recordedAt);
  if (!Number.isFinite(recordedAt.getTime()) || recordedAt > new Date())
    throw new ActionError('Das Nachweisdatum darf nicht in der Zukunft liegen.');
  if (input.status !== 'PREPARED' && !input.evidenceVersionId)
    throw new ActionError('Für externe Statusangaben eine belegte Dokumentfassung auswählen.');
  if (input.evidenceVersionId) {
    const evidence = await tx.documentVersion.findFirst({
      where: {
        id: input.evidenceVersionId,
        scanStatus: 'CLEAN',
        scanCompletedAt: { not: null },
        document: {
          tenantId: session.user.tenantId,
          clientId: poa.clientId,
          deletedAt: null,
          gwgDestroyedAt: null,
          gwgDestructionRequestedAt: null,
          classification: { notIn: ['GWG_EVIDENCE', 'STAFF_PRIVATE', 'PERSONNEL'] },
        },
      },
      select: { id: true },
    });
    if (!evidence)
      throw new ActionError('Nachweis nicht verfügbar oder nicht demselben Mandanten zugeordnet.');
  }
  const record = await tx.vdbRecord.create({
    data: {
      tenantId: session.user.tenantId,
      clientId: poa.clientId,
      poaId: poa.id,
      status: input.status,
      revision: input.expectedRevision + 1,
      externalReference: input.externalReference,
      evidenceVersionId: input.evidenceVersionId,
      note: input.note,
      recordedAt,
      createdBy: session.user.staffId,
    },
  });
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: 'poa.vdb.record',
    resourceType: 'client',
    resourceId: poa.clientId,
    after: {
      poaId: poa.id,
      recordId: record.id,
      revision: record.revision,
      status: record.status,
      evidenceVersionId: record.evidenceVersionId,
    },
  });
}
