import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '@taxtronik/storage';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { PDFDocument } from 'pdf-lib';
import { ActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { checkStaffExportLimit, checkPortalWriteLimit } from '@/server/rate-limit';
import {
  persistResumableDocumentUpload,
  ResumableDocumentUploadError,
} from '@/server/documents/resumable-upload';
import { assistanceAccess, assistanceDocumentWhere, type Surface } from './service';
import { assistancePdf, assistanceDocx, type AssistanceReport } from './report';
import { CASE_KINDS, type CaseKind } from './definitions';
import {
  ASSISTANCE_GENERATOR,
  DOCX_MIME,
  checkedAssistanceSnapshot,
  type AssistanceSnapshot,
} from './snapshot';

export const ArchiveInput = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  kind: z.enum(CASE_KINDS),
  revision: z.number().int().positive(),
  format: z.enum(['pdf', 'docx', 'merged']),
  shareWithClient: z.boolean().default(false),
});
const MAX_SOURCE_BYTES = 25n * 1024n * 1024n;
export async function assistanceVersionTx(
  tx: TxClient,
  surface: Surface,
  tenantId: string,
  clientId: string,
  id: string,
  expectedHash: string | null,
) {
  const version = await tx.documentVersion.findFirst({
    where: {
      id,
      scanStatus: 'CLEAN',
      scanCompletedAt: { not: null },
      document: assistanceDocumentWhere(surface, tenantId, clientId),
    },
    include: {
      document: { select: { id: true, title: true, mimeType: true, sharedWithClientAt: true } },
    },
  });
  if (!version || (expectedHash && Buffer.from(version.sha256).toString('hex') !== expectedHash))
    throw new ActionError(
      'Die gebundene Dokumentfassung ist nicht verfügbar oder nicht mehr freigegeben.',
    );
  return version;
}
export async function readAssistanceBytes(version: {
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  sizeBytes: bigint;
  sha256: Uint8Array;
}): Promise<Buffer> {
  if (version.sizeBytes > MAX_SOURCE_BYTES)
    throw new ActionError('Die ausgewählte Datei überschreitet 25 MiB.');
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: version.storageBucket,
      Key: version.storageKey,
      ...(version.storageVersionId ? { VersionId: version.storageVersionId } : {}),
    }),
  );
  if (!object.Body || object.ContentLength !== Number(version.sizeBytes))
    throw new ActionError('Dateigröße stimmt nicht mit der gespeicherten Fassung überein.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > Number(version.sizeBytes)) throw new ActionError('Dateigröße überschritten.');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (
    size !== Number(version.sizeBytes) ||
    createHash('sha256').update(bytes).digest('hex') !== Buffer.from(version.sha256).toString('hex')
  )
    throw new ActionError('Integritätsprüfung der Dokumentfassung fehlgeschlagen.');
  return bytes;
}
export async function assistanceRevisionTx(
  tx: TxClient,
  id: string,
  clientId: string,
  kind: CaseKind,
  revision: number,
) {
  const row = await tx.clientAssistanceRevision.findFirst({
    where: { revision, case: { id, clientId, kind } },
    include: { case: { select: { tenantId: true } } },
  });
  if (!row || !row.snapshotHash)
    throw new ActionError('Für diese Fassung liegt kein vollständiger Ausgabesnapshot vor.');
  let snapshot: AssistanceSnapshot;
  try {
    snapshot = checkedAssistanceSnapshot(row.snapshot, row.snapshotHash);
  } catch {
    throw new ActionError('Der gespeicherte Fassungsnachweis ist nicht konsistent.');
  }
  if (snapshot.caseId !== id || snapshot.revision !== revision || snapshot.kind !== kind)
    throw new ActionError('Fassung nicht verfügbar.');
  return { row, snapshot };
}
export async function checkAssistanceSourcesTx(
  tx: TxClient,
  surface: Surface,
  tenantId: string,
  clientId: string,
  snapshot: AssistanceSnapshot,
) {
  if (snapshot.sourceVersionId)
    await assistanceVersionTx(
      tx,
      surface,
      tenantId,
      clientId,
      snapshot.sourceVersionId,
      snapshot.sourceHash,
    );
  if (snapshot.externalVersionId)
    await assistanceVersionTx(
      tx,
      surface,
      tenantId,
      clientId,
      snapshot.externalVersionId,
      snapshot.externalHash,
    );
}
export function reportForSnapshot(snapshot: AssistanceSnapshot, hash: string): AssistanceReport {
  return {
    title: snapshot.externalVersionId
      ? snapshot.title + ' – Prüfprotokoll externe Word-Fassung'
      : snapshot.title,
    kind: snapshot.kind,
    revision: snapshot.revision,
    status: snapshot.status,
    createdAt: snapshot.occurredAt,
    answers: snapshot.answers,
    sourceHash: snapshot.sourceHash,
    fields: snapshot.schema.fields,
    snapshotHash: hash,
    externalHash: snapshot.externalHash,
    reviewNote: snapshot.reviewNote,
  };
}
async function mergedReceipt(source: Buffer, mime: string, supplement: Buffer, at: string) {
  const out = await PDFDocument.create();
  out.setCreationDate(new Date(at));
  out.setModificationDate(new Date(at));
  if (mime === 'application/pdf') {
    const original = await PDFDocument.load(source);
    if (original.getPageCount() > 200)
      throw new ActionError('Originalbeleg umfasst mehr als 200 Seiten.');
    for (const page of await out.copyPages(original, original.getPageIndices())) out.addPage(page);
  } else if (mime === 'image/jpeg' || mime === 'image/png') {
    const image = mime === 'image/jpeg' ? await out.embedJpg(source) : await out.embedPng(source);
    const scaled = image.scale(Math.min(1, 500 / image.width, 740 / image.height));
    const page = out.addPage([595.28, 841.89]);
    page.drawImage(image, {
      x: 45,
      y: 841.89 - 45 - scaled.height,
      width: scaled.width,
      height: scaled.height,
    });
  } else
    throw new ActionError(
      'Die kombinierte Ansicht unterstützt PDF, JPEG und PNG. Original und Ergänzung bleiben getrennt abrufbar.',
    );
  const addition = await PDFDocument.load(supplement);
  for (const page of await out.copyPages(addition, addition.getPageIndices())) out.addPage(page);
  return Buffer.from(await out.save());
}
export async function archiveAssistance(surface: Surface, raw: unknown) {
  const input = ArchiveInput.parse(raw);
  const access = await assistanceAccess(surface, input.kind, input.clientId);
  const { ctx } = access;
  const rate =
    surface === 'staff'
      ? await checkStaffExportLimit('client-assistance-archive', ctx.actorId!)
      : await checkPortalWriteLimit(ctx.actorId!);
  if (!rate.ok) throw new ActionError('Zu viele Ausgaben. Bitte später erneut versuchen.');
  const prepared = await withTenantContext(ctx, async (tx) => {
    await access.guardMutationTx(tx);
    const { row, snapshot } = await assistanceRevisionTx(
      tx,
      input.id,
      input.clientId,
      input.kind,
      input.revision,
    );
    if (input.format === 'docx' && input.kind !== 'PROCEDURE')
      throw new ActionError('Word-Ausgaben sind für Verfahrensdokumentationen vorgesehen.');
    if (input.format === 'merged' && (input.kind !== 'BEWIRTUNG' || !snapshot.sourceVersionId))
      throw new ActionError(
        'Die kombinierte Ansicht benötigt eine Bewirtungsergänzung mit Originalbeleg.',
      );
    await checkAssistanceSourcesTx(tx, surface, ctx.tenantId, input.clientId, snapshot);
    const existing = await tx.clientAssistanceOutput.findFirst({
      where: { revisionId: row.id, format: input.format, generatorVersion: ASSISTANCE_GENERATOR },
      include: {
        documentVersion: { include: { document: { select: { sharedWithClientAt: true } } } },
      },
    });
    if (existing) {
      if (
        surface === 'portal' &&
        existing.createdBy !== ctx.actorId &&
        !existing.documentVersion?.document.sharedWithClientAt
      )
        throw new ActionError('Die Kanzleiausgabe ist noch nicht für das Portal freigegeben.');
      return { snapshot, hash: row.snapshotHash, output: existing };
    }
    const manifest = {
      version: 1,
      caseId: input.id,
      revision: input.revision,
      revisionId: row.id,
      snapshotHash: row.snapshotHash,
      sourceVersionId: snapshot.sourceVersionId,
      sourceHash: snapshot.sourceHash,
      externalVersionId: snapshot.externalVersionId,
      externalHash: snapshot.externalHash,
      generator: ASSISTANCE_GENERATOR,
      format: input.format,
    };
    const output = await tx.clientAssistanceOutput.create({
      data: {
        revisionId: row.id,
        format: input.format,
        generatorVersion: ASSISTANCE_GENERATOR,
        snapshotHash: row.snapshotHash,
        manifest,
        createdBy: ctx.actorId!,
        actorType: ctx.actorType,
      },
      include: {
        documentVersion: { include: { document: { select: { sharedWithClientAt: true } } } },
      },
    });
    return { snapshot, hash: row.snapshotHash, output };
  });
  const { snapshot, output } = prepared;
  const share = surface === 'portal' || input.shareWithClient;
  if (output.status === 'READY') {
    await withTenantContext(ctx, async (tx) => {
      await access.guardMutationTx(tx);
      await checkAssistanceSourcesTx(tx, surface, ctx.tenantId, input.clientId, snapshot);
      const version = await assistanceVersionTx(
        tx,
        surface,
        ctx.tenantId,
        input.clientId,
        output.documentVersionId!,
        output.outputHash,
      );
      if (surface === 'staff' && share && !version.document.sharedWithClientAt) {
        await tx.document.update({
          where: { id: version.documentId },
          data: { sharedWithClientAt: new Date() },
        });
        await evidenceService.record(tx, {
          tenantId: ctx.tenantId,
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: 'client_assistance.output_shared',
          resourceType: 'document',
          resourceId: version.documentId,
          after: { outputId: output.id },
        });
      }
    });
    return { id: input.id };
  }
  const mime = input.format === 'docx' ? DOCX_MIME : 'application/pdf';
  const classification = input.kind === 'PROCEDURE' ? 'GOBD_TAX' : 'GOBD_INVOICE';
  const guardOutputTx = async (tx: TxClient) => {
    await access.guardMutationTx(tx);
    await checkAssistanceSourcesTx(tx, surface, ctx.tenantId, input.clientId, snapshot);
    await tx.$queryRaw`SELECT id FROM client_assistance_output WHERE id=${output.id}::uuid FOR UPDATE`;
    const fresh = await tx.clientAssistanceOutput.findUniqueOrThrow({ where: { id: output.id } });
    if (
      fresh.snapshotHash !== prepared.hash ||
      fresh.documentVersionId !== output.documentVersionId
    )
      throw new ActionError(
        'Diese Ausgabe wurde gleichzeitig vorbereitet. Bitte erneut aufrufen; die bestehende Speicherabsicht wird wiederverwendet.',
      );
  };
  const readBytes = async () => {
    const report = reportForSnapshot(snapshot, prepared.hash);
    if (input.format === 'docx' && snapshot.externalVersionId) {
      const version = await withTenantContext(ctx, async (tx) => {
        await access.guardMutationTx(tx);
        return assistanceVersionTx(
          tx,
          surface,
          ctx.tenantId,
          input.clientId,
          snapshot.externalVersionId!,
          snapshot.externalHash,
        );
      });
      return readAssistanceBytes(version);
    }
    if (input.format === 'docx') return assistanceDocx(report);
    const pdf = await assistancePdf(report);
    if (input.format === 'pdf') return pdf;
    const version = await withTenantContext(ctx, async (tx) => {
      await access.guardMutationTx(tx);
      return assistanceVersionTx(
        tx,
        surface,
        ctx.tenantId,
        input.clientId,
        snapshot.sourceVersionId!,
        snapshot.sourceHash,
      );
    });
    return mergedReceipt(
      await readAssistanceBytes(version),
      version.document.mimeType,
      pdf,
      snapshot.occurredAt,
    );
  };
  try {
    await persistResumableDocumentUpload({
      context: ctx,
      resumeDocumentId: output.documentVersion?.documentId,
      createdById: ctx.actorId!,
      documentData: {
        tenantId: ctx.tenantId,
        clientId: input.clientId,
        title: `${snapshot.title} – Fassung ${snapshot.revision}${input.format === 'merged' ? ' – kombinierte Ansicht' : snapshot.externalVersionId && input.format === 'pdf' ? ' – Prüfprotokoll' : ''}`,
        classification,
        mimeType: mime,
      },
      resumeWhere: { clientId: input.clientId, classification, mimeType: mime, deletedAt: null },
      storage: {
        tier: 'GOBD',
        classification,
        expectedMime: mime,
        retentionAnchor: new Date(snapshot.occurredAt),
      },
      readBytes,
      validatePrepared(prepared) {
        if (prepared.detectedMime !== mime)
          throw new ActionError('Die Ausgabe besitzt nicht den erwarteten Dateityp.');
      },
      guardMutationTx: guardOutputTx,
      async recordPendingTx(tx, pending) {
        const version = await tx.documentVersion.findUniqueOrThrow({
          where: { id: pending.versionId },
          select: { sha256: true },
        });
        await tx.clientAssistanceOutput.update({
          where: { id: output.id },
          data: {
            status: 'PENDING',
            documentVersionId: pending.versionId,
            outputHash: Buffer.from(version.sha256).toString('hex'),
          },
        });
        await evidenceService.record(tx, {
          tenantId: ctx.tenantId,
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: 'document.upload.pending',
          resourceType: 'document',
          resourceId: pending.documentId,
          after: {
            source: 'client_assistance',
            outputId: output.id,
            snapshotHash: prepared.hash,
            generator: ASSISTANCE_GENERATOR,
          },
        });
      },
      async recordCompleteTx(tx, complete) {
        await access.guardMutationTx(tx);
        await checkAssistanceSourcesTx(tx, surface, ctx.tenantId, input.clientId, snapshot);
        await tx.clientAssistanceOutput.update({
          where: { id: output.id },
          data: { status: 'READY', completedAt: new Date() },
        });
        if (share)
          await tx.document.update({
            where: { id: complete.documentId },
            data: { sharedWithClientAt: new Date() },
          });
        await evidenceService.record(tx, {
          tenantId: ctx.tenantId,
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: 'document.upload.complete',
          resourceType: 'document',
          resourceId: complete.documentId,
          after: {
            source: 'client_assistance',
            outputId: output.id,
            revision: snapshot.revision,
            sharedWithClient: share,
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof ResumableDocumentUploadError) {
      if (error.phase === 'prepare' && error.cause instanceof ActionError) throw error.cause;
      throw new ActionError(
        error.pendingDocumentId
          ? 'Ausgabe noch nicht vollständig abgelegt. Erneut aufrufen, um dieselbe Speicherabsicht fortzusetzen.'
          : 'Die Ausgabe konnte nicht vorbereitet werden. Bitte Dokumentzugriff und Scan-/Speicherdienst prüfen.',
      );
    }
    throw error;
  }
  return { id: input.id };
}
