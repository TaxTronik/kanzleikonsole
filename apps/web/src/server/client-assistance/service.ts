import { z } from 'zod';
import { withTenantContext, type TxClient, type TenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { portalActionGuard } from '@/server/actions/portal-action';
import { assertClientAccessTx, ActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import {
  CASE_DEFINITIONS,
  caseModule,
  validateCaseAnswers,
  type CaseKind,
  type CaseField,
  CASE_KINDS,
} from './definitions';
import { assistanceSnapshotHash, buildAssistanceSnapshot, DOCX_MIME } from './snapshot';
import { checkPortalWriteLimit } from '@/server/rate-limit';

export type Surface = 'staff' | 'portal';
export function assistanceDocumentWhere(surface: Surface, tenantId: string, clientId: string) {
  return {
    tenantId,
    clientId,
    deletedAt: null,
    gwgDestroyedAt: null,
    gwgDestructionRequestedAt: null,
    requiresPayrollAccess: false,
    classification: {
      notIn: ['GWG_EVIDENCE', 'STAFF_PRIVATE', 'PERSONNEL'] as Array<
        'GWG_EVIDENCE' | 'STAFF_PRIVATE' | 'PERSONNEL'
      >,
    },
    ...(surface === 'portal' ? { sharedWithClientAt: { not: null } } : {}),
  };
}
const inputSchema = z.object({
  id: z.uuid().optional(),
  clientId: z.uuid(),
  kind: z.enum(CASE_KINDS),
  expectedRevision: z.number().int().nonnegative(),
  submit: z.boolean(),
  confirmed: z.boolean(),
  answers: z.record(z.string(), z.string().max(12000)),
  sourceVersionId: z.union([z.uuid(), z.literal('')]).optional(),
});
type AssistanceInput = z.infer<typeof inputSchema>;
export async function assistanceAccess(surface: Surface, kind: CaseKind, clientId: string) {
  const guard =
    surface === 'staff'
      ? await staffActionGuard({ module: caseModule(kind) })
      : await portalActionGuard({ module: caseModule(kind) });
  if (!guard.ok) throw new ActionError(guard.error);
  const guardMutationTx = async (tx: TxClient) => {
    if ('staffId' in guard) await assertClientAccessTx(tx, guard.session, clientId);
    else if (guard.clientId !== clientId) throw new ActionError('Kein Zugriff.');
    const client = await tx.client.findFirst({
      where: {
        id: clientId,
        tenantId: guard.ctx.tenantId,
        allowActive: true,
        anonymizedAt: null,
        mandateEndedAt: null,
      },
      select: { id: true },
    });
    if (!client) throw new ActionError('Mandat nicht aktiv.');
  };
  return { ctx: guard.ctx, guardMutationTx };
}
export async function withAssistance<T>(
  surface: Surface,
  kind: CaseKind,
  clientId: string,
  fn: (tx: TxClient, ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const access = await assistanceAccess(surface, kind, clientId);
  return withTenantContext(access.ctx, async (tx) => {
    await access.guardMutationTx(tx);
    return fn(tx, access.ctx);
  });
}
async function recordRevisionTx(tx: TxClient, ctx: TenantContext, id: string) {
  const item = await tx.clientAssistanceCase.findUniqueOrThrow({ where: { id } });
  const occurredAt = new Date();
  const snapshot = buildAssistanceSnapshot(item, occurredAt);
  await tx.clientAssistanceRevision.create({
    data: {
      caseId: id,
      revision: item.revision,
      answers: item.answers as Record<string, string>,
      status: item.status,
      actorId: ctx.actorId!,
      actorType: ctx.actorType,
      occurredAt,
      snapshot,
      snapshotHash: assistanceSnapshotHash(snapshot),
      sourceVersionId: item.sourceDocumentVersionId,
      externalVersionId: item.externalDocumentVersionId,
    },
  });
}

async function assertAssistanceWriteLimit(surface: Surface, actorId: string | null): Promise<void> {
  if (surface === 'portal' && !(await checkPortalWriteLimit(actorId!)).ok)
    throw new ActionError('Zu viele Änderungen. Bitte später erneut versuchen.');
}

async function selectedAssistanceSourceHashTx(
  tx: TxClient,
  surface: Surface,
  ctx: TenantContext,
  input: AssistanceInput,
): Promise<string | null> {
  if (!input.sourceVersionId) return null;
  const version = await tx.documentVersion.findFirst({
    where: {
      id: input.sourceVersionId,
      scanStatus: 'CLEAN',
      scanCompletedAt: { not: null },
      document: assistanceDocumentWhere(surface, ctx.tenantId, input.clientId),
    },
    select: { sha256: true },
  });
  if (!version) throw new ActionError('Originalbeleg nicht verfügbar oder nicht geprüft.');
  return Buffer.from(version.sha256).toString('hex');
}

async function previousAssistanceCaseTx(tx: TxClient, ctx: TenantContext, input: AssistanceInput) {
  if (!input.id) return null;
  const previous = await tx.clientAssistanceCase.findFirst({
    where: {
      id: input.id,
      tenantId: ctx.tenantId,
      clientId: input.clientId,
      kind: input.kind,
    },
  });
  if (!previous) throw new ActionError('Vorgang nicht gefunden.');
  return previous;
}

type AssistanceCase = NonNullable<Awaited<ReturnType<typeof previousAssistanceCaseTx>>>;

async function assertPreviousAssistanceSourceTx(
  tx: TxClient,
  surface: Surface,
  ctx: TenantContext,
  input: AssistanceInput,
  previous: AssistanceCase | null,
): Promise<void> {
  if (previous?.externalDocumentVersionId)
    throw new ActionError(
      'Für eine externe Word-Fassung bitte die korrigierte Datei als neue Fassung übernehmen. Strukturfelder werden nicht automatisch synchronisiert.',
    );
  if (!previous?.sourceDocumentVersionId) return;
  const source = await tx.documentVersion.findFirst({
    where: {
      id: previous.sourceDocumentVersionId,
      scanStatus: 'CLEAN',
      scanCompletedAt: { not: null },
      document: assistanceDocumentWhere(surface, ctx.tenantId, input.clientId),
    },
    select: { sha256: true },
  });
  if (!source || Buffer.from(source.sha256).toString('hex') !== previous.sourceHash)
    throw new ActionError('Der fest verbundene Originalbeleg ist nicht verfügbar.');
}

function assistanceFields(previous: AssistanceCase | null, input: AssistanceInput): CaseField[] {
  return previous
    ? (previous.schemaSnapshot as unknown as { fields: CaseField[] }).fields
    : CASE_DEFINITIONS[input.kind].fields;
}

function assistanceSourceId(
  previous: AssistanceCase | null,
  input: AssistanceInput,
): string | null {
  return previous?.sourceDocumentVersionId ?? input.sourceVersionId ?? null;
}

function assertAssistanceInput(
  input: AssistanceInput,
  previous: AssistanceCase | null,
  fields: CaseField[],
  sourceId: string | null,
): void {
  const errors = validateCaseAnswers(
    input.kind,
    input.answers,
    input.submit,
    input.confirmed,
    fields,
  );
  if (errors.length) throw new ActionError(errors.join(' '));
  if (previous && previous.revision !== input.expectedRevision)
    throw new ActionError('Der Vorgang wurde zwischenzeitlich geändert. Bitte neu laden.');
  if (previous && !['DRAFT', 'RETURNED'].includes(previous.status))
    throw new ActionError(
      'Zuerst eine Korrektur anfordern; eingereichte Fassungen bleiben unverändert.',
    );
  if (
    previous?.sourceDocumentVersionId &&
    input.sourceVersionId &&
    previous.sourceDocumentVersionId !== input.sourceVersionId
  )
    throw new ActionError('Der Originalbeleg ist bereits fest mit diesem Vorgang verbunden.');
  if (input.submit && input.kind === 'BEWIRTUNG' && !sourceId)
    throw new ActionError('Bitte einen geprüften Originalbeleg zuordnen.');
}

function assistanceMutation(
  surface: Surface,
  ctx: TenantContext,
  input: AssistanceInput,
  previous: AssistanceCase | null,
  sourceId: string | null,
  selectedSourceHash: string | null,
) {
  const revision = (previous?.revision ?? 0) + 1;
  return {
    revision,
    data: {
      answers: input.answers,
      revision,
      status: input.submit ? 'SUBMITTED' : 'DRAFT',
      sourceDocumentVersionId: sourceId || null,
      sourceHash: previous?.sourceHash ?? selectedSourceHash,
      confirmedAt: input.submit && input.confirmed ? new Date() : null,
      reviewedByStaff: null,
      reviewNote: null,
      submittedByContact:
        surface === 'portal' && input.submit ? ctx.actorId : (previous?.submittedByContact ?? null),
    },
  } as const;
}

async function persistAssistanceCaseTx(
  tx: TxClient,
  ctx: TenantContext,
  input: AssistanceInput,
  previous: AssistanceCase | null,
  data: ReturnType<typeof assistanceMutation>['data'],
): Promise<string> {
  if (previous) {
    const updated = await tx.clientAssistanceCase.updateMany({
      where: { id: previous.id, revision: input.expectedRevision },
      data,
    });
    if (updated.count !== 1) throw new ActionError('Konkurrierende Änderung.');
    return previous.id;
  }
  const created = await tx.clientAssistanceCase.create({
    data: {
      tenantId: ctx.tenantId,
      clientId: input.clientId,
      kind: input.kind,
      title: CASE_DEFINITIONS[input.kind].title,
      schemaSnapshot: JSON.parse(JSON.stringify(CASE_DEFINITIONS[input.kind])),
      ...data,
    },
  });
  return created.id;
}

export async function saveAssistance(surface: Surface, raw: unknown): Promise<{ id: string }> {
  const input = inputSchema.parse(raw);
  return withAssistance(surface, input.kind, input.clientId, async (tx, ctx) => {
    await assertAssistanceWriteLimit(surface, ctx.actorId);
    const sourceHash = await selectedAssistanceSourceHashTx(tx, surface, ctx, input);
    const previous = await previousAssistanceCaseTx(tx, ctx, input);
    await assertPreviousAssistanceSourceTx(tx, surface, ctx, input, previous);
    const sourceId = assistanceSourceId(previous, input);
    assertAssistanceInput(input, previous, assistanceFields(previous, input), sourceId);
    const mutation = assistanceMutation(surface, ctx, input, previous, sourceId, sourceHash);
    const id = await persistAssistanceCaseTx(tx, ctx, input, previous, mutation.data);
    await recordRevisionTx(tx, ctx, id);
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: 'client_assistance.' + (input.submit ? 'submitted' : 'saved'),
      resourceType: 'client_assistance_case',
      resourceId: id,
      after: {
        revision: mutation.revision,
        kind: input.kind,
        sourceHash: previous?.sourceHash ?? sourceHash,
        confirmed: input.confirmed,
      },
    });
    return { id };
  });
}
export async function reviewAssistance(raw: unknown) {
  const input = z
    .object({
      id: z.uuid(),
      clientId: z.uuid(),
      kind: z.enum(CASE_KINDS),
      expectedRevision: z.number().int(),
      decision: z.enum(['REVIEWED', 'RETURNED']),
      note: z.string().trim().min(1).max(5000),
    })
    .parse(raw);
  return withAssistance('staff', input.kind, input.clientId, async (tx, ctx) => {
    const item = await tx.clientAssistanceCase.findFirst({
      where: {
        id: input.id,
        clientId: input.clientId,
        kind: input.kind,
        revision: input.expectedRevision,
      },
    });
    if (!item || !['SUBMITTED', 'REVIEWED'].includes(item.status))
      throw new ActionError('Vorgang nicht zur Prüfung verfügbar.');
    if (item.status === 'REVIEWED' && input.decision === 'REVIEWED')
      throw new ActionError(
        'Diese Fassung wurde bereits geprüft. Für Änderungen eine Korrektur anfordern.',
      );
    for (const versionId of [item.sourceDocumentVersionId, item.externalDocumentVersionId].filter(
      (id): id is string => Boolean(id),
    )) {
      if (
        !(await tx.documentVersion.findFirst({
          where: {
            id: versionId,
            scanStatus: 'CLEAN',
            scanCompletedAt: { not: null },
            document: assistanceDocumentWhere('staff', ctx.tenantId, input.clientId),
          },
          select: { id: true },
        }))
      )
        throw new ActionError('Eine gebundene Dokumentfassung ist nicht verfügbar.');
    }
    const revision = item.revision + 1;
    const updated = await tx.clientAssistanceCase.updateMany({
      where: { id: item.id, revision: item.revision },
      data: {
        status: input.decision,
        reviewNote: input.note,
        reviewedByStaff: ctx.actorId,
        revision,
      },
    });
    if (updated.count !== 1) throw new ActionError('Konkurrierende Änderung.');
    await recordRevisionTx(tx, ctx, item.id);
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'client_assistance.reviewed',
      resourceType: 'client_assistance_case',
      resourceId: item.id,
      after: { revision, decision: input.decision, note: input.note },
    });
    return { id: item.id };
  });
}

export async function reimportAssistance(surface: Surface, raw: unknown) {
  const input = z
    .object({
      id: z.uuid(),
      clientId: z.uuid(),
      kind: z.literal('PROCEDURE'),
      expectedRevision: z.number().int().positive(),
      documentVersionId: z.uuid(),
      confirmed: z.literal(true),
    })
    .parse(raw);
  return withAssistance(surface, input.kind, input.clientId, async (tx, ctx) => {
    if (surface === 'portal' && !(await checkPortalWriteLimit(ctx.actorId!)).ok)
      throw new ActionError('Zu viele Änderungen. Bitte später erneut versuchen.');
    const item = await tx.clientAssistanceCase.findFirst({
      where: {
        id: input.id,
        clientId: input.clientId,
        kind: input.kind,
        revision: input.expectedRevision,
      },
    });
    if (!item) throw new ActionError('Vorgang wurde geändert. Bitte neu laden.');
    const version = await tx.documentVersion.findFirst({
      where: {
        id: input.documentVersionId,
        scanStatus: 'CLEAN',
        scanCompletedAt: { not: null },
        document: {
          ...assistanceDocumentWhere(surface, ctx.tenantId, input.clientId),
          mimeType: DOCX_MIME,
        },
      },
      select: { id: true, sha256: true },
    });
    if (!version)
      throw new ActionError(
        'Eine geprüfte Word-Datei desselben Mandanten aus der Dokumentablage auswählen.',
      );
    const hash = Buffer.from(version.sha256).toString('hex');
    if (hash === item.externalDocumentHash)
      throw new ActionError('Diese unveränderten Word-Inhalte sind bereits die aktuelle Fassung.');
    const changed = await tx.clientAssistanceCase.updateMany({
      where: { id: item.id, revision: input.expectedRevision },
      data: {
        revision: item.revision + 1,
        status: 'SUBMITTED',
        externalDocumentVersionId: version.id,
        externalDocumentHash: hash,
        reviewedByStaff: null,
        reviewNote: null,
        confirmedAt: new Date(),
        submittedByContact: surface === 'portal' ? ctx.actorId : item.submittedByContact,
      },
    });
    if (changed.count !== 1) throw new ActionError('Konkurrierende Änderung. Bitte neu laden.');
    await recordRevisionTx(tx, ctx, item.id);
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: 'client_assistance.word_reimported',
      resourceType: 'client_assistance_case',
      resourceId: item.id,
      after: {
        revision: item.revision + 1,
        externalDocumentVersionId: version.id,
        externalHash: hash,
        reviewRequired: true,
      },
    });
    return { id: item.id };
  });
}
