import type { TxClient } from '@taxtronik/db';
import type { StaffCtx } from '@/server/actions/staff-action';
import { ActionError } from '@/server/actions/action-error';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { readFormSchema } from '@/server/forms/schema-snapshot';
import { validateFormAnswers } from '@/server/forms/validate-answers';
import type { Prisma } from '@prisma/client';

function isReturnableCampaignSubmission(
  entry: { clientId: string },
  submission: {
    id: string;
    clientId: string;
    requestId: string | null;
    submittedAt: Date | null;
    status: string;
  } | null,
  request: {
    id: string;
    clientId: string;
    formSubmissionId: string | null;
    status: string;
  } | null,
): boolean {
  return Boolean(
    submission &&
    request &&
    submission.clientId === entry.clientId &&
    request.clientId === entry.clientId &&
    request.formSubmissionId === submission.id &&
    submission.requestId === request.id &&
    submission.submittedAt &&
    ['SUBMITTED', 'REVIEWED'].includes(submission.status) &&
    request.status !== 'CANCELLED',
  );
}

// Fachkatalog: YEAR-END-CAMPAIGN-001, REQ-LIFECYCLE-001.
export async function returnCampaignSubmissionTx(
  tx: TxClient,
  g: StaffCtx,
  input: { entryId: string; note: string; updatedAt: Date },
) {
  const entry = await tx.yearEndCampaignEntry.findUnique({ where: { id: input.entryId } });
  if (!entry || entry.tenantId !== g.tenantId)
    throw new ActionError('Kampagnenvorgang nicht gefunden.');
  await assertClientAccessTx(tx, g.session, entry.clientId);
  await tx.$queryRaw`SELECT id FROM form_submission WHERE id=${entry.submissionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM request WHERE id=${entry.requestId}::uuid FOR UPDATE`;
  const sub = await tx.formSubmission.findUnique({ where: { id: entry.submissionId } });
  const request = await tx.request.findUnique({ where: { id: entry.requestId } });
  if (!isReturnableCampaignSubmission(entry, sub, request))
    throw new ActionError(
      'Nur einen eingereichten, nicht abgebrochenen Kampagnenvorgang zurückgeben.',
    );
  if (!sub || !request || !sub.submittedAt)
    throw new ActionError(
      'Nur einen eingereichten, nicht abgebrochenen Kampagnenvorgang zurückgeben.',
    );
  if (sub.updatedAt.getTime() !== input.updatedAt.getTime())
    throw new ActionError('Formular wurde zwischenzeitlich geändert. Bitte neu laden.');
  if (!sub.schemaSnapshot) throw new ActionError('Eingefrorener Fragenstand fehlt.');
  const schema = readFormSchema(sub.schemaSnapshot, {
    name: '',
    description: null,
    introMd: null,
    fields: [],
  });
  const { fileReferences } = validateFormAnswers(
    schema.fields,
    sub.answers as Record<string, unknown>,
    { requireRequired: true },
  );
  const sources = [];
  for (const ref of fileReferences) {
    await tx.$queryRaw`SELECT id FROM document WHERE id=${ref.documentId}::uuid FOR SHARE`;
    const document = await tx.document.findFirst({
      where: {
        id: ref.documentId,
        tenantId: g.tenantId,
        clientId: entry.clientId,
        formSubmissionId: sub.id,
        formFieldKey: ref.fieldKey,
        deletedAt: null,
      },
      include: {
        versions: {
          where: { createdAt: { lte: sub.submittedAt } },
          orderBy: { versionNo: 'desc' },
          take: 1,
        },
      },
    });
    const version = document?.versions[0];
    if (!version || version.scanStatus !== 'CLEAN' || !version.storageVersionId)
      throw new ActionError(
        'Ursprüngliche saubere Dateiversion ist nicht eindeutig verfügbar. Keine Rückgabe erfolgt.',
      );
    sources.push({
      fieldKey: ref.fieldKey,
      documentVersionId: version.id,
      sha256: Buffer.from(version.sha256).toString('hex'),
    });
  }
  const previous = await tx.formSubmissionRevision.findFirst({
    where: { submissionId: sub.id },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  await tx.formSubmissionRevision.create({
    data: {
      tenantId: g.tenantId,
      submissionId: sub.id,
      sequence: (previous?.sequence ?? 0) + 1,
      schemaSnapshot: sub.schemaSnapshot as Prisma.InputJsonValue,
      answers: sub.answers as Prisma.InputJsonValue,
      submittedAt: sub.submittedAt,
      submittedByContact: sub.submittedByContact,
      capturedByStaff: g.staffId,
      files: { create: sources },
    },
  });
  const changed = await tx.formSubmission.updateMany({
    where: { id: sub.id, status: sub.status, updatedAt: input.updatedAt },
    data: { status: 'DRAFT', reviewedAt: null, reviewedByStaff: null },
  });
  if (changed.count !== 1) throw new ActionError('Formular wurde zwischenzeitlich geändert.');
  await tx.request.update({
    where: { id: request.id },
    data: { status: 'IN_PROGRESS', closedAt: null, closedByStaff: null },
  });
  await tx.requestResponse.create({
    data: {
      requestId: request.id,
      authorType: 'STAFF',
      authorId: g.staffId,
      message: 'Jahreswechsel-Rückfrage:\n' + input.note,
    },
  });
  await evidenceService.record(tx, {
    tenantId: g.tenantId,
    actorType: 'STAFF',
    actorId: g.staffId,
    action: 'request.reopen',
    resourceType: 'request',
    resourceId: request.id,
    before: { status: request.status, formStatus: sub.status },
    after: {
      status: 'IN_PROGRESS',
      formStatus: 'DRAFT',
      formSubmissionId: sub.id,
      yearEndCampaignId: entry.campaignId,
    },
  });
}
