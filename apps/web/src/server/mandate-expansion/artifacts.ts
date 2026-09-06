import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MandateArtifact, DocumentClassification, Prisma } from '@prisma/client';
import { withTenantContext, type TxClient, type TenantContext } from '@taxtronik/db';
import { classificationToTier } from '@taxtronik/storage';
import { staffActionGuard } from '@/server/actions/staff-action';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import {
  persistResumableDocumentUpload,
  ResumableDocumentUploadError,
} from '@/server/documents/resumable-upload';
import { readAssistanceBytes } from '@/server/client-assistance/outputs';
import {
  buildZip,
  acquireZipBuildSlot,
  sanitizeZipFileName,
  type ZipEntry,
} from '@/server/export/zip';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import { checkStaffExportLimit } from '@/server/rate-limit';
import { loadStructureTx } from './service';
import { structurePdf, handoverPdf } from './pdf';
import {
  payrollHandoverAllowedTx,
  sensitiveHandoverDocument,
  handoverPreparationHash,
} from './offboarding';
export { handoverPreparationHash } from './offboarding';

export const MANDATE_GENERATOR = 'mandate-artifact/1';
const ArtifactDocument = z.object({
  versionId: z.uuid(),
  documentId: z.uuid(),
  title: z.string(),
  mimeType: z.string(),
  classification: z.string(),
  requiresPayrollAccess: z.boolean(),
  sha256: z.string(),
  sizeBytes: z.string(),
  approvedBy: z.uuid(),
  approvedAt: z.string(),
  sensitiveApproved: z.boolean(),
});
export const HandoverArtifactSnapshot = z.object({
  version: z.literal(1),
  clientId: z.uuid(),
  clientName: z.string(),
  recipient: z.string().min(10),
  endDate: z.string(),
  sourceHash: z.string(),
  handoverNote: z.string(),
  retentionNote: z.string(),
  deadlines: z.array(
    z.object({ kind: z.string(), period: z.string(), dueDate: z.string(), status: z.string() }),
  ),
  notices: z.array(
    z.object({
      kind: z.string(),
      period: z.string(),
      appealDeadline: z.string().nullable(),
      status: z.string(),
    }),
  ),
  documents: z.array(ArtifactDocument),
});
type HandoverDocument = z.infer<typeof ArtifactDocument>;
const ARTIFACT_SOURCE_INCLUDE = {
  documentVersion: { include: { document: true } },
} satisfies Prisma.MandateArtifactSourceInclude;
type ArtifactSource = Prisma.MandateArtifactSourceGetPayload<{
  include: typeof ARTIFACT_SOURCE_INCLUDE;
}>;
const OFFBOARDING_INCLUDE = {
  documents: { include: { documentVersion: { include: { document: true } } } },
} satisfies Prisma.MandateOffboardingInclude;
type OffboardingWithDocuments = Prisma.MandateOffboardingGetPayload<{
  include: typeof OFFBOARDING_INCLUDE;
}>;

function artifactSourceIsAvailable(source: ArtifactSource, artifact: MandateArtifact): boolean {
  const version = source.documentVersion;
  return Boolean(
    version &&
    version.document.clientId === artifact.clientId &&
    version.document.tenantId === artifact.tenantId &&
    version.scanStatus === 'CLEAN' &&
    version.scanCompletedAt &&
    !version.document.deletedAt &&
    !version.document.gwgDestroyedAt &&
    !version.document.gwgDestructionRequestedAt &&
    Buffer.from(version.sha256).toString('hex') === source.sourceHash,
  );
}

function artifactSourceMatchesSnapshot(
  source: ArtifactSource,
  snapshot: z.infer<typeof HandoverArtifactSnapshot> | null,
): boolean {
  if (!snapshot) return true;
  const version = source.documentVersion;
  const bound = snapshot?.documents.find((document) => document.versionId === version?.id);
  return Boolean(
    version &&
    bound &&
    bound.classification === version.document.classification &&
    bound.requiresPayrollAccess === version.document.requiresPayrollAccess &&
    bound.sha256 === source.sourceHash,
  );
}

type OffboardingDocument = OffboardingWithDocuments['documents'][number];

function offboardingDocumentIsAvailable(
  row: OffboardingDocument,
  run: OffboardingWithDocuments,
  tenantId: string,
): boolean {
  const version = row.documentVersion;
  return Boolean(
    version &&
    row.approvedAt &&
    row.approvedBy &&
    version.document.clientId === run.clientId &&
    version.document.tenantId === tenantId &&
    version.scanStatus === 'CLEAN' &&
    version.scanCompletedAt &&
    !version.document.deletedAt &&
    !version.document.gwgDestroyedAt &&
    !version.document.gwgDestructionRequestedAt,
  );
}

function checkedHandoverDocument(
  row: OffboardingDocument,
  run: OffboardingWithDocuments,
  tenantId: string,
  payrollAllowed: boolean,
): HandoverDocument {
  if (!offboardingDocumentIsAvailable(row, run, tenantId))
    throw new ActionError(
      'Eine ausgewählte Fassung ist nicht verfügbar oder besitzt noch keine ausdrückliche Herausgabefreigabe. Bitte Übergabe erneut vorbereiten.',
    );
  const version = row.documentVersion!;
  if (sensitiveHandoverDocument(version.document) && !row.sensitiveApproved)
    throw new ActionError('Zusätzliche Freigabe für eine sensible Dokumentfassung fehlt.');
  if (
    (version.document.classification === 'PERSONNEL' || version.document.requiresPayrollAccess) &&
    !payrollAllowed
  )
    throw new ActionError('Für Personalunterlagen ist PAYROLL_MANAGE erforderlich.');
  return {
    versionId: version.id,
    documentId: version.documentId,
    title: version.document.title,
    mimeType: version.document.mimeType,
    classification: version.document.classification,
    requiresPayrollAccess: version.document.requiresPayrollAccess,
    sha256: Buffer.from(version.sha256).toString('hex'),
    sizeBytes: version.sizeBytes.toString(),
    approvedBy: row.approvedBy!,
    approvedAt: row.approvedAt!.toISOString(),
    sensitiveApproved: row.sensitiveApproved,
  };
}

function checkedHandoverDocuments(
  run: OffboardingWithDocuments,
  tenantId: string,
  payrollAllowed: boolean,
): HandoverDocument[] {
  return run.documents.map((row) => checkedHandoverDocument(row, run, tenantId, payrollAllowed));
}

export function handoverGroups(documents: HandoverDocument[]) {
  const groups: Array<{
    key: string;
    classification: DocumentClassification;
    payroll: boolean;
    documents: HandoverDocument[];
  }> = [];
  for (const document of [...documents].sort((a, b) => a.versionId.localeCompare(b.versionId))) {
    if (BigInt(document.sizeBytes) > 24n * 1024n * 1024n)
      throw new ActionError(
        'Ein Dokument überschreitet die Grenze von 24 MiB für archivierte Übergabeteile.',
      );
    const payroll = document.requiresPayrollAccess || document.classification === 'PERSONNEL';
    const prefix = document.classification + (payroll ? '-payroll' : '');
    let group = [...groups]
      .reverse()
      .find(
        (g) =>
          g.key.startsWith(prefix + ':') &&
          g.documents.reduce((s, d) => s + BigInt(d.sizeBytes), 0n) + BigInt(document.sizeBytes) <=
            24n * 1024n * 1024n,
      );
    if (!group) {
      group = {
        key: prefix + ':' + (groups.filter((g) => g.key.startsWith(prefix + ':')).length + 1),
        classification: document.classification as DocumentClassification,
        payroll,
        documents: [],
      };
      groups.push(group);
    }
    group.documents.push(document);
  }
  return groups;
}
export async function assertMandateArtifactTx(
  tx: TxClient,
  session: StaffSession,
  artifact: MandateArtifact,
) {
  await assertClientAccessTx(tx, session, artifact.clientId);
  const allowed = await tx.$queryRaw<
    Array<{ allowed: boolean }>
  >`SELECT app.mandate_artifact_allowed(${artifact.id}::uuid) AS allowed`;
  if (allowed[0]?.allowed !== true)
    throw new ActionError('Die Ausgabe ist mit den aktuellen Rechten nicht verfügbar.');
  if (artifact.structureVersionId) {
    if (!(await loadStructureTx(tx, session, artifact.clientId, artifact.structureVersionId)))
      throw new ActionError('Struktur nicht verfügbar.');
  }
  const sources = await tx.mandateArtifactSource.findMany({
    where: { artifactId: artifact.id },
    include: ARTIFACT_SOURCE_INCLUDE,
  });
  const snapshot =
    artifact.kind === 'OFFBOARDING'
      ? z.object({ snapshot: HandoverArtifactSnapshot }).parse(artifact.manifest).snapshot
      : null;
  for (const source of sources) {
    if (!artifactSourceIsAvailable(source, artifact))
      throw new ActionError(
        'Eine gebundene Quelle ist nicht mehr verfügbar; keine Wiederherstellung vernichteter Fassungen.',
      );
    if (!artifactSourceMatchesSnapshot(source, snapshot))
      throw new ActionError(
        'Die Schutzklasse einer gebundenen Quelle hat sich geändert. Übergabe erneut prüfen.',
      );
  }
  if (snapshot && snapshot.documents.length !== sources.length)
    throw new ActionError('Die gebundene Quellenliste ist unvollständig.');
  return sources;
}
async function persistArtifact(
  ctx: TenantContext,
  session: StaffSession,
  artifact: MandateArtifact,
  readBytes: () => Promise<Buffer>,
) {
  const check = async (tx: TxClient) => {
    await assertMandateArtifactTx(tx, session, artifact);
    await tx.$queryRaw`SELECT id FROM mandate_artifact WHERE id=${artifact.id}::uuid FOR UPDATE`;
    const fresh = await tx.mandateArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
    if (fresh.documentVersionId !== artifact.documentVersionId)
      throw new ActionError(
        'Die Ausgabe wurde gleichzeitig vorbereitet. Bitte denselben Vorgang erneut aufrufen.',
      );
  };
  if (artifact.status === 'READY') {
    if (!artifact.documentVersionId)
      throw new ActionError(
        'Die frühere Ausgabedatei ist nicht mehr verfügbar und wird nicht neu erzeugt.',
      );
    return;
  }
  const mime =
    artifact.kind === 'STRUCTURE' || artifact.groupKey === 'PROTOCOL'
      ? 'application/pdf'
      : 'application/zip';
  try {
    await persistResumableDocumentUpload({
      context: ctx,
      resumeDocumentId: artifact.documentId,
      createdById: session.user.staffId,
      documentData: {
        tenantId: artifact.tenantId,
        clientId: artifact.clientId,
        title:
          (artifact.kind === 'STRUCTURE' ? 'Mandatsstruktur' : 'Mandatsübergabe') +
          ' – ' +
          artifact.groupKey +
          ' – ' +
          artifact.sourceHash.slice(0, 10),
        classification: artifact.classification as DocumentClassification,
        mimeType: mime,
        requiresPayrollAccess: artifact.requiresPayrollAccess,
        sharedWithClientAt: null,
      },
      resumeWhere: {
        clientId: artifact.clientId,
        classification: artifact.classification as DocumentClassification,
        requiresPayrollAccess: artifact.requiresPayrollAccess,
        sharedWithClientAt: null,
        deletedAt: null,
      },
      storage: {
        tier: classificationToTier(artifact.classification),
        classification: artifact.classification,
        expectedMime: mime,
      },
      readBytes,
      validatePrepared(prepared) {
        if (prepared.detectedMime !== mime)
          throw new ActionError('Unerwarteter Dateityp der Ausgabe.');
      },
      guardMutationTx: check,
      async recordPendingTx(tx, pending) {
        const version = await tx.documentVersion.findUniqueOrThrow({
          where: { id: pending.versionId },
          select: { sha256: true },
        });
        await tx.mandateArtifact.update({
          where: { id: artifact.id },
          data: {
            documentId: pending.documentId,
            documentVersionId: pending.versionId,
            outputHash: Buffer.from(version.sha256).toString('hex'),
            status: 'PENDING',
          },
        });
        await evidenceService.record(tx, {
          tenantId: ctx.tenantId,
          actorType: 'STAFF',
          actorId: session.user.staffId,
          action: 'document.upload.pending',
          resourceType: 'document',
          resourceId: pending.documentId,
          after: {
            source: 'mandate_artifact',
            artifactId: artifact.id,
            generator: MANDATE_GENERATOR,
            sourceHash: artifact.sourceHash,
          },
        });
      },
      async recordCompleteTx(tx, complete) {
        await assertMandateArtifactTx(tx, session, artifact);
        await tx.mandateArtifact.update({
          where: { id: artifact.id },
          data: { status: 'READY', completedAt: new Date() },
        });
        await evidenceService.record(tx, {
          tenantId: ctx.tenantId,
          actorType: 'STAFF',
          actorId: session.user.staffId,
          action: 'document.upload.complete',
          resourceType: 'document',
          resourceId: complete.documentId,
          after: { source: 'mandate_artifact', artifactId: artifact.id },
        });
      },
    });
  } catch (error) {
    if (error instanceof ResumableDocumentUploadError) {
      if (error.phase === 'prepare' && error.cause instanceof ActionError) throw error.cause;
      throw new ActionError(
        error.pendingDocumentId
          ? 'Ausgabe noch unvollständig. Erneut aufrufen, um denselben dokumentierten Speicherintent fortzusetzen.'
          : 'Ausgabe konnte nicht vorbereitet werden. Dateigröße, Scanner und Speicher prüfen.',
      );
    }
    throw error;
  }
}
export async function archiveStructure(raw: unknown) {
  const input = z.object({ clientId: z.uuid(), versionId: z.uuid() }).parse(raw);
  const guard = await staffActionGuard({ module: 'mandateStructure' });
  if (!guard.ok) throw new ActionError(guard.error);
  if (!(await checkStaffExportLimit('mandate-archive', guard.staffId)).ok)
    throw new ActionError('Zu viele Ausgaben. Bitte später erneut versuchen.');
  const prepared = await withTenantContext(guard.ctx, async (tx) => {
    const version = await loadStructureTx(tx, guard.session, input.clientId, input.versionId);
    if (!version) throw new ActionError('Struktur nicht verfügbar.');
    const sourceKey = 'structure:' + version.id + ':' + version.contentHash;
    let artifact = await tx.mandateArtifact.findFirst({
      where: { tenantId: guard.tenantId, sourceKey, generatorVersion: MANDATE_GENERATOR },
    });
    if (!artifact)
      artifact = await tx.mandateArtifact.create({
        data: {
          tenantId: guard.tenantId,
          clientId: input.clientId,
          structureVersionId: version.id,
          sourceKey,
          sourceHash: version.contentHash,
          generatorVersion: MANDATE_GENERATOR,
          manifest: {
            version: 1,
            structureVersionId: version.id,
            revision: version.revision,
            sourceHash: version.contentHash,
            generator: MANDATE_GENERATOR,
          },
          kind: 'STRUCTURE',
          groupKey: 'PDF',
          classification: 'STAFF_PRIVATE',
          createdBy: guard.staffId,
        },
      });
    return { version, artifact };
  });
  await persistArtifact(guard.ctx, guard.session, prepared.artifact, () =>
    structurePdf(
      prepared.version.input,
      prepared.version.revision,
      prepared.version.contentHash,
      new Date(prepared.version.createdAt),
    ),
  );
  return prepared.artifact.id;
}
export async function archiveOffboarding(raw: unknown) {
  const input = z
    .object({ id: z.uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(raw);
  const guard = await staffActionGuard({ module: 'mandateOffboarding', requireAdmin: true });
  if (!guard.ok) throw new ActionError(guard.error);
  if (!(await checkStaffExportLimit('mandate-archive', guard.staffId)).ok)
    throw new ActionError('Zu viele Ausgaben. Bitte später erneut versuchen.');
  const prepared = await withTenantContext(guard.ctx, async (tx) => {
    const run = await tx.mandateOffboarding.findFirst({
      where: { id: input.id, tenantId: guard.tenantId, client: { anonymizedAt: null } },
      include: OFFBOARDING_INCLUDE,
    });
    if (!run) throw new ActionError('Übergabe nicht verfügbar.');
    await assertClientAccessTx(tx, guard.session, run.clientId);
    if (handoverPreparationHash(run) !== input.expectedHash)
      throw new ActionError('Der freigegebene Übergabeumfang wurde geändert. Bitte neu laden.');
    const payroll = await payrollHandoverAllowedTx(tx, guard.session);
    const documents = checkedHandoverDocuments(run, guard.tenantId, payroll);
    const source = z
      .object({
        clientName: z.string(),
        deadlines: HandoverArtifactSnapshot.shape.deadlines,
        notices: HandoverArtifactSnapshot.shape.notices,
      })
      .parse(run.sourceSnapshot);
    const snapshot = HandoverArtifactSnapshot.parse({
      version: 1,
      clientId: run.clientId,
      ...source,
      recipient: run.recipient,
      endDate: run.endDate.toISOString().slice(0, 10),
      sourceHash: run.sourceHash,
      handoverNote: run.handoverNote,
      retentionNote: run.retentionNote,
      documents: documents.sort((a, b) => a.versionId.localeCompare(b.versionId)),
    });
    const groups = handoverGroups(documents);
    const protocolClass = documents.some((d) => d.classification === 'GWG_EVIDENCE')
      ? 'GWG_EVIDENCE'
      : 'STAFF_PRIVATE';
    const protocolPayroll = documents.some(
      (d) => d.requiresPayrollAccess || d.classification === 'PERSONNEL',
    );
    const artifacts: MandateArtifact[] = [];
    for (const group of [
      {
        key: 'PROTOCOL',
        classification: protocolClass as DocumentClassification,
        payroll: protocolPayroll,
        documents,
      },
      ...groups,
    ]) {
      const sourceKey = 'offboarding:' + run.id + ':' + input.expectedHash + ':' + group.key;
      let artifact = await tx.mandateArtifact.findFirst({
        where: { tenantId: guard.tenantId, sourceKey, generatorVersion: MANDATE_GENERATOR },
      });
      if (!artifact) {
        artifact = await tx.mandateArtifact.create({
          data: {
            tenantId: guard.tenantId,
            clientId: run.clientId,
            offboardingId: run.id,
            sourceKey,
            sourceHash: input.expectedHash,
            generatorVersion: MANDATE_GENERATOR,
            manifest: {
              version: 1,
              generator: MANDATE_GENERATOR,
              preparationHash: input.expectedHash,
              groupKey: group.key,
              snapshot: { ...snapshot, documents: group.documents },
            },
            kind: 'OFFBOARDING',
            groupKey: group.key,
            classification: group.classification,
            requiresPayrollAccess: group.payroll,
            createdBy: guard.staffId,
          },
        });
        if (group.documents.length)
          await tx.mandateArtifactSource.createMany({
            data: group.documents.map((d) => ({
              artifactId: artifact!.id,
              documentVersionId: d.versionId,
              sourceHash: d.sha256,
            })),
          });
      }
      artifacts.push(artifact);
    }
    return { artifacts };
  });
  for (const artifact of prepared.artifacts)
    await persistArtifact(guard.ctx, guard.session, artifact, async () => {
      const manifest = z.object({ snapshot: HandoverArtifactSnapshot }).parse(artifact.manifest);
      const snapshot = manifest.snapshot;
      if (artifact.groupKey === 'PROTOCOL')
        return handoverPdf({
          ...snapshot,
          handoverNote: `Bestätigter Empfänger: ${snapshot.recipient}\n\n${snapshot.handoverNote}`,
          preparationHash: artifact.sourceHash,
          generator: artifact.generatorVersion,
          createdAt: artifact.createdAt,
        });
      const release = await acquireZipBuildSlot();
      try {
        const entries: ZipEntry[] = [];
        const sources = await withTenantContext(guard.ctx, (tx) =>
          assertMandateArtifactTx(tx, guard.session, artifact),
        );
        for (const [index, d] of snapshot.documents.entries()) {
          const source = sources.find((s) => s.documentVersionId === d.versionId);
          if (!source?.documentVersion)
            throw new ActionError('Gebundene Fassung nicht mehr vorhanden.');
          entries.push({
            name:
              'dokumente/' +
              String(index + 1).padStart(3, '0') +
              '_' +
              sanitizeZipFileName(filenameWithExtension(d.title, d.mimeType)),
            data: await readAssistanceBytes(source.documentVersion),
            modifiedAt: artifact.createdAt,
          });
        }
        const safeManifest = {
          artifactId: artifact.id,
          generator: MANDATE_GENERATOR,
          preparationHash: artifact.sourceHash,
          groupKey: artifact.groupKey,
          recipient: snapshot.recipient,
          sourceHash: snapshot.sourceHash,
          documents: snapshot.documents,
          protocol: 'Das getrennte PDF-Prüfprotokoll gehört zu demselben Vorbereitungshash.',
        };
        entries.push({
          name: 'inhaltsverzeichnis-und-freigaben.json',
          data: Buffer.from(JSON.stringify(safeManifest, null, 2)),
          modifiedAt: artifact.createdAt,
        });
        return buildZip(entries);
      } finally {
        release();
      }
    });
  return prepared.artifacts.map((a) => a.id);
}
export async function loadArtifactDownload(session: StaffSession, ctx: TenantContext, id: string) {
  const data = await withTenantContext(ctx, async (tx) => {
    const artifact = await tx.mandateArtifact.findFirst({
      where: { id, tenantId: ctx.tenantId, status: 'READY' },
      include: { documentVersion: { include: { document: true } } },
    });
    if (!artifact?.documentVersion)
      throw new ActionError(
        'Die abgelegte Ausgabe ist nicht verfügbar; sie wird nicht aus vernichteten Quellen rekonstruiert.',
      );
    await assertMandateArtifactTx(tx, session, artifact);
    const v = artifact.documentVersion;
    if (
      v.scanStatus !== 'CLEAN' ||
      !v.scanCompletedAt ||
      v.document.deletedAt ||
      v.document.gwgDestroyedAt ||
      v.document.gwgDestructionRequestedAt ||
      Buffer.from(v.sha256).toString('hex') !== artifact.outputHash
    )
      throw new ActionError('Ausgabedatei nicht verfügbar.');
    return artifact;
  });
  const bytes = await readAssistanceBytes(data.documentVersion!);
  await withTenantContext(ctx, async (tx) => {
    await assertMandateArtifactTx(tx, session, data);
    const available = await tx.documentVersion.findFirst({
      where: {
        id: data.documentVersionId!,
        scanStatus: 'CLEAN',
        document: { deletedAt: null, gwgDestroyedAt: null, gwgDestructionRequestedAt: null },
      },
    });
    if (!available) throw new ActionError('Die Ausgabe ist nicht mehr verfügbar.');
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: session.user.staffId,
      action: 'mandate.artifact.download',
      resourceType: 'client',
      resourceId: data.clientId,
      after: {
        artifactId: id,
        sourceHash: data.sourceHash,
        outputHash: createHash('sha256').update(bytes).digest('hex'),
      },
    });
  });
  return {
    bytes,
    title: data.documentVersion!.document.title,
    mimeType: data.documentVersion!.document.mimeType,
  };
}
