import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx, isStaffAdmin } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { contentHash, parseEndDate } from './model';
import { assistanceSnapshotHash } from '@/server/client-assistance/snapshot';

export function handoverPreparationHash(run: {
  sourceHash: string;
  recipient: string;
  endDate: Date;
  handoverNote: string;
  retentionNote: string;
  documents: Array<{
    documentVersionId: string | null;
    approvedBy: string | null;
    approvedAt: Date | null;
    sensitiveApproved: boolean;
  }>;
}) {
  return assistanceSnapshotHash({
    sourceHash: run.sourceHash,
    recipient: run.recipient,
    endDate: run.endDate.toISOString(),
    handoverNote: run.handoverNote,
    retentionNote: run.retentionNote,
    documents: run.documents
      .map((d) => ({
        id: d.documentVersionId,
        approvedBy: d.approvedBy,
        approvedAt: d.approvedAt?.toISOString() ?? null,
        sensitiveApproved: d.sensitiveApproved,
      }))
      .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')),
  });
}

export function sensitiveHandoverDocument(document: {
  classification: string;
  requiresPayrollAccess?: boolean;
}) {
  return (
    Boolean(document.requiresPayrollAccess) ||
    ['GWG_EVIDENCE', 'STAFF_PRIVATE', 'PERSONNEL'].includes(document.classification)
  );
}
export async function payrollHandoverAllowedTx(tx: TxClient, session: StaffSession) {
  const rows = await tx.$queryRaw<
    Array<{ allowed: boolean }>
  >`SELECT app.expansion_staff_permission(${session.user.tenantId}::uuid,${session.user.staffId}::uuid,'PAYROLL_MANAGE') AS allowed`;
  return rows?.[0]?.allowed === true;
}

export async function offboardingSourceTx(tx: TxClient, session: StaffSession, clientId: string) {
  await assertClientAccessTx(tx, session, clientId);
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId: session.user.tenantId, anonymizedAt: null },
    select: { id: true, name: true, mandateEndedAt: true },
  });
  if (!client) throw new ActionError('Mandant nicht verfügbar.');
  const payrollAllowed = await payrollHandoverAllowedTx(tx, session);
  const [documents, deadlines, notices, requests, contacts, checks] = await Promise.all([
    tx.document.findMany({
      where: {
        clientId,
        tenantId: session.user.tenantId,
        deletedAt: null,
        ...(!payrollAllowed
          ? { classification: { not: 'PERSONNEL' as const }, requiresPayrollAccess: false }
          : {}),
        gwgDestructionRequestedAt: null,
        gwgDestroyedAt: null,
        mandateArtifact: null,
      },
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      orderBy: { id: 'asc' },
      take: 201,
    }),
    tx.taxDeadline.findMany({
      where: { clientId, tenantId: session.user.tenantId, status: { notIn: ['DONE', 'SKIPPED'] } },
      select: { id: true, kind: true, period: true, dueDate: true, status: true },
      orderBy: { id: 'asc' },
      take: 1001,
    }),
    tx.taxNotice.findMany({
      where: { clientId, tenantId: session.user.tenantId, appealResolvedAt: null },
      select: { id: true, kind: true, period: true, appealDeadline: true, status: true },
      orderBy: { id: 'asc' },
      take: 1001,
    }),
    tx.request.findMany({
      where: {
        clientId,
        tenantId: session.user.tenantId,
        status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
      },
      select: { id: true, title: true, status: true },
      orderBy: { id: 'asc' },
      take: 1001,
    }),
    tx.clientContact.findMany({
      where: { clientId, tenantId: session.user.tenantId, active: true },
      select: { id: true },
      orderBy: { id: 'asc' },
    }),
    tx.gwgCheck.findMany({
      where: { clientId, tenantId: session.user.tenantId, destroyedAt: null },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  if (
    documents.length > 200 ||
    deadlines.length > 1000 ||
    notices.length > 1000 ||
    requests.length > 1000
  )
    throw new ActionError(
      'Der Bestand ist für den interaktiven Übergabeumfang zu groß. Bitte zunächst fachlich eingrenzen; es wird nichts gekürzt.',
    );
  const docs = documents
    .filter((d) => d.versions[0]?.scanStatus === 'CLEAN' && d.versions[0]?.scanCompletedAt)
    .map((d) => ({
      id: d.id,
      title: d.title,
      classification: d.classification,
      requiresPayrollAccess: d.requiresPayrollAccess,
      versionId: d.versions[0]!.id,
      sha256: Buffer.from(d.versions[0]!.sha256).toString('hex'),
      sizeBytes: d.versions[0]!.sizeBytes.toString(),
      retentionUntil: d.retentionUntil?.toISOString() ?? null,
    }));
  const snapshot = {
    clientId,
    clientName: client.name,
    documents: docs,
    deadlines: deadlines.map((d) => ({ ...d, dueDate: d.dueDate.toISOString() })),
    notices: notices.map((n) => ({
      ...n,
      appealDeadline: n.appealDeadline?.toISOString() ?? null,
    })),
    requests,
    contactIds: contacts.map((c) => c.id),
    gwgChecks: checks,
  };
  return { client, snapshot, hash: contentHash(snapshot) };
}
export async function prepareOffboardingTx(
  tx: TxClient,
  session: StaffSession,
  input: {
    clientId: string;
    expectedHash: string;
    endDate: string;
    versionIds: string[];
    handoverNote: string;
    retentionNote: string;
    recipient: string;
    sensitiveVersionIds: string[];
  },
) {
  if (!isStaffAdmin(session))
    throw new ActionError('Nur ADMIN/PARTNER darf die Beendigung vorbereiten.');
  await tx.$queryRaw`SELECT id FROM client WHERE id=${input.clientId}::uuid AND tenant_id=${session.user.tenantId}::uuid FOR UPDATE`;
  const source = await offboardingSourceTx(tx, session, input.clientId);
  if (source.client.mandateEndedAt) throw new ActionError('Das Mandat ist bereits beendet.');
  if (source.hash !== input.expectedHash)
    throw new ActionError('Die Akte hat sich geändert. Bitte neu laden und erneut prüfen.');
  if (input.recipient.trim().length < 10)
    throw new ActionError('Empfänger mit Name und eindeutiger Zustell-/Kontaktangabe bestätigen.');
  let endDate: Date;
  try {
    endDate = parseEndDate(input.endDate);
  } catch (e) {
    throw new ActionError((e as Error).message);
  }
  const ids = [...new Set(input.versionIds)];
  if (ids.some((id) => !source.snapshot.documents.some((d) => d.versionId === id)))
    throw new ActionError(
      'Eine ausgewählte Dokumentfassung ist nicht mehr freigegeben oder verfügbar.',
    );
  if (
    ids.some((id) => {
      const d = source.snapshot.documents.find((d) => d.versionId === id)!;
      return sensitiveHandoverDocument(d) && !input.sensitiveVersionIds.includes(id);
    })
  )
    throw new ActionError(
      'Jede ausgewählte sensible Fassung benötigt eine zusätzliche ausdrückliche Herausgabefreigabe für den Empfänger.',
    );
  if (
    ids.some(
      (id) =>
        BigInt(source.snapshot.documents.find((d) => d.versionId === id)!.sizeBytes) >
        24n * 1024n * 1024n,
    )
  )
    throw new ActionError(
      'Eine Dokumentfassung überschreitet 24 MiB. Für diesen Umfang ist ein gesonderter Übergabeweg erforderlich.',
    );
  if (
    ids.reduce(
      (sum, id) =>
        sum + BigInt(source.snapshot.documents.find((d) => d.versionId === id)!.sizeBytes),
      0n,
    ) >
    100n * 1024n * 1024n
  )
    throw new ActionError('Das Übergabepaket darf höchstens 100 MiB umfassen.');
  const existing = await tx.mandateOffboarding.findFirst({
    where: { clientId: input.clientId, tenantId: session.user.tenantId, completedAt: null },
  });
  const data = {
    endDate,
    sourceHash: source.hash,
    sourceSnapshot: source.snapshot,
    handoverNote: input.handoverNote,
    retentionNote: input.retentionNote,
    recipient: input.recipient.trim(),
  };
  const run = existing
    ? await tx.mandateOffboarding.update({ where: { id: existing.id }, data })
    : await tx.mandateOffboarding.create({
        data: {
          ...data,
          tenantId: session.user.tenantId,
          clientId: input.clientId,
          createdBy: session.user.staffId,
        },
      });
  await tx.mandateOffboardingDocument.deleteMany({
    where: { offboardingId: run.id, tenantId: session.user.tenantId },
  });
  if (ids.length)
    await tx.mandateOffboardingDocument.createMany({
      data: ids.map((documentVersionId) => ({
        tenantId: session.user.tenantId,
        offboardingId: run.id,
        documentVersionId,
        approvedBy: session.user.staffId,
        approvedAt: new Date(),
        sensitiveApproved: input.sensitiveVersionIds.includes(documentVersionId),
      })),
    });
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: 'mandate.offboarding.prepare',
    resourceType: 'client',
    resourceId: input.clientId,
    after: { offboardingId: run.id, sourceHash: source.hash, selectedDocuments: ids.length },
  });
  return run.id;
}
export async function finishOffboardingTx(
  tx: TxClient,
  session: StaffSession,
  id: string,
  expectedHash: string,
) {
  if (!isStaffAdmin(session)) throw new ActionError('Nur ADMIN/PARTNER darf das Mandat beenden.');
  const run = await tx.mandateOffboarding.findFirst({
    where: { id, tenantId: session.user.tenantId },
  });
  if (!run) throw new ActionError('Übergabe nicht gefunden.');
  await assertClientAccessTx(tx, session, run.clientId);
  await tx.$queryRaw`SELECT id FROM client WHERE id=${run.clientId}::uuid AND tenant_id=${session.user.tenantId}::uuid FOR UPDATE`;
  const current = await tx.mandateOffboarding.findFirst({
    where: { id, tenantId: session.user.tenantId, completedAt: null },
    include: { documents: true },
  });
  if (!current) throw new ActionError('Diese Übergabe wurde bereits abgeschlossen.');
  const source = await offboardingSourceTx(tx, session, run.clientId);
  if (source.client.mandateEndedAt || source.hash !== current.sourceHash)
    throw new ActionError('Akte oder Mandatsstatus geändert. Übergabe erneut vorbereiten.');
  if (handoverPreparationHash(current) !== expectedHash)
    throw new ActionError(
      'Empfänger oder Freigabestand wurde geändert. Vor dem Abschluss neu laden und erneut prüfen.',
    );
  const artifacts = await tx.mandateArtifact.findMany({
    where: { offboardingId: id, sourceHash: handoverPreparationHash(current) },
    include: { documentVersion: { include: { document: true } } },
  });
  if (
    !artifacts.some((a) => a.groupKey === 'PROTOCOL') ||
    artifacts.some(
      (a) =>
        a.status !== 'READY' ||
        !a.documentVersion ||
        a.documentVersion.scanStatus !== 'CLEAN' ||
        !a.documentVersion.scanCompletedAt ||
        a.documentVersion.document.deletedAt ||
        a.documentVersion.document.gwgDestroyedAt ||
        a.documentVersion.document.gwgDestructionRequestedAt,
    )
  )
    throw new ActionError(
      'Zuerst das PDF-Protokoll und sämtliche ZIP-Teile dieses Freigabestands vollständig archivieren und prüfen.',
    );
  const completedAt = new Date();
  await tx.client.update({
    where: { id: run.clientId },
    data: { mandateEndedAt: current.endDate },
  });
  await tx.mandateOffboarding.update({ where: { id }, data: { completedAt } });
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: 'client.mandate.end',
    resourceType: 'client',
    resourceId: run.clientId,
    after: {
      offboardingId: id,
      mandateEndedAt: current.endDate.toISOString(),
      sourceHash: current.sourceHash,
      portalAccess: 'blocked_by_mandate_state',
      retentionDecision: 'manual_review_only',
    },
  });
  return { clientId: run.clientId, contactIds: source.snapshot.contactIds };
}
