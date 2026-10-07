import type { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';

import { withTenantContext, type ActorType, type TxClient } from '@taxtronik/db';
import { sanitizeFilenameForHeader, streamVerifiedObject } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { getClientIp } from '@/server/rate-limit';
import { documentPreviewMetadata, loadDocumentPreview } from '@/server/storage/document-preview';
import { effectiveDocumentMime, filenameWithExtension } from '@/server/storage/preview-mime';
import { isDocumentVersionReady } from './delivery-readiness';

export interface DocumentDeliverySource {
  title: string;
  mimeType: string;
  classification: string;
  clientId: string | null;
  bucket: string;
  key: string;
  storageVersionId?: string | null;
  /** Gebundene Fassung: wird beim Ausliefern immer gegen den Objektinhalt geprüft (R-05). */
  sha256: Uint8Array;
  sizeBytes: bigint;
  isPoaDocument: boolean;
}

interface DeliveryCandidate {
  id: string;
  clientId: string | null;
}

export interface LoadDocumentDeliveryOptions {
  tenantId: string;
  actorId: string;
  actorType: Extract<ActorType, 'STAFF' | 'CLIENT_CONTACT'>;
  documentId: string;
  action: 'document.download' | 'document.preview';
  request: NextRequest;
  where: Prisma.DocumentWhereInput;
  /** Surface-spezifisches Mandanten-Zugriffsgate; `false` wird als 404 behandelt. */
  authorize?: (tx: TxClient, document: DeliveryCandidate) => Promise<boolean>;
  /** Staff-Preview bleibt auch bei einem fehlgeschlagenen Audit-Nebeneintrag nutzbar. */
  auditFailure?: 'reject' | 'ignore';
}

/** Eine Vorschau besteht aus Metadaten-Request (JSON mit Stream-URL) und Byte-Request. */
function isPreviewStreamRequest(request: NextRequest): boolean {
  return request.nextUrl.searchParams.get('stream') === '1';
}

/**
 * P-12: Abrufnachweis nur für den Request, der Dokumentbytes ausliefert. Der
 * Metadaten-Request einer Vorschau liefert Titel, Typ und die Stream-URL; die
 * Bytes folgen im `?stream=1`-Request, der weiterhin vollständig geprüft und
 * auditiert wird. Vorher entstanden pro Vorschau zwei `document.preview`-Einträge.
 */
function auditsAccess(options: LoadDocumentDeliveryOptions): boolean {
  return options.action !== 'document.preview' || isPreviewStreamRequest(options.request);
}

async function recordAccess(tx: TxClient, options: LoadDocumentDeliveryOptions): Promise<void> {
  await evidenceService.record(tx, {
    tenantId: options.tenantId,
    actorType: options.actorType,
    actorId: options.actorId,
    action: options.action,
    resourceType: 'document',
    resourceId: options.documentId,
    ip: getClientIp(options.request.headers),
    userAgent: options.request.headers.get('user-agent'),
  });
}

/**
 * Gemeinsamer, actor-neutraler Ladepfad fuer Staff- und Portal-Auslieferung.
 * Die aufrufende Surface liefert ihren expliziten `where`-Filter und optional
 * ihr RBAC-Gate; dadurch werden die beiden Sicherheitsgrenzen nicht vermischt.
 *
 * Fachkatalog: DOC-PORTAL-SHARING-001.
 */
export async function loadDocumentDelivery(
  options: LoadDocumentDeliveryOptions,
): Promise<DocumentDeliverySource | null> {
  const ctx = {
    tenantId: options.tenantId,
    actorId: options.actorId,
    actorType: options.actorType,
  } as const;
  const ignoreAuditFailure = options.auditFailure === 'ignore';
  const auditThisRequest = auditsAccess(options);

  const document = await withTenantContext(ctx, async (tx) => {
    const candidate = await tx.document.findFirst({
      where: options.where,
      select: {
        id: true,
        title: true,
        mimeType: true,
        classification: true,
        requiresPayrollAccess: true,
        clientId: true,
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 1,
          select: {
            storageBucket: true,
            storageKey: true,
            storageVersionId: true,
            sha256: true,
            sizeBytes: true,
            scanStatus: true,
            scanCompletedAt: true,
          },
        },
      },
    });
    const version = candidate?.versions[0];
    if (!candidate || !version || !isDocumentVersionReady(version)) return null;
    if (candidate.requiresPayrollAccess) {
      if (options.actorType !== 'STAFF') return null;
      const allowed = await tx.$queryRaw<
        Array<{ allowed: boolean }>
      >`SELECT app.expansion_staff_permission(${options.tenantId}::uuid,${options.actorId}::uuid,'PAYROLL_MANAGE') AS allowed`;
      if (allowed[0]?.allowed !== true) return null;
    }
    if (options.authorize && !(await options.authorize(tx, candidate))) return null;

    if (auditThisRequest && !ignoreAuditFailure) await recordAccess(tx, options);

    const powerOfAttorney = await tx.powerOfAttorney.findFirst({
      where: { tenantId: options.tenantId, documentId: candidate.id },
      select: { id: true },
    });

    return {
      title: candidate.title,
      mimeType: candidate.mimeType,
      classification: candidate.classification,
      clientId: candidate.clientId,
      bucket: version.storageBucket,
      key: version.storageKey,
      storageVersionId: version.storageVersionId,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      isPoaDocument: Boolean(powerOfAttorney),
    };
  });

  if (document && auditThisRequest && ignoreAuditFailure) {
    // Eigene Transaktion: Ein SQL-Fehler setzt eine Postgres-Transaktion auf
    // aborted. Nur die Trennung macht "Preview trotz Audit-Fehler" wirklich
    // best effort, statt den anschliessenden Commit doch scheitern zu lassen.
    await withTenantContext(ctx, (tx) => recordAccess(tx, options)).catch((error: unknown) => {
      // F-05: Die Vorschau bleibt verfügbar, der fehlende Zugriffsnachweis
      // aber nicht unbemerkt (Dokument-ID und Aktion, keine Personendaten).
      log.error(
        {
          component: 'document-delivery',
          documentId: options.documentId,
          action: options.action,
          errName: error instanceof Error ? error.name : typeof error,
          err: error instanceof Error ? error.message : String(error),
        },
        'document-delivery: Zugriff nicht protokolliert',
      );
    });
  }

  return document;
}

export async function documentDownloadResponse(
  document: DocumentDeliverySource,
  options: { mimeSource: 'validated-document' | 'storage-when-present' },
): Promise<NextResponse> {
  // R-05: Größe und SHA-256 der gebundenen Fassung werden beim Streamen geprüft;
  // eine Abweichung bricht die Antwort ab, statt sie vollständig auszuliefern.
  const object = await streamVerifiedObject(
    { bucket: document.bucket, key: document.key, versionId: document.storageVersionId },
    { sizeBytes: document.sizeBytes, sha256: document.sha256 },
  );
  const mimeInput =
    options.mimeSource === 'storage-when-present'
      ? { ...document, mimeType: object.contentType ?? document.mimeType }
      : document;
  const contentType = effectiveDocumentMime(mimeInput);
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(filenameWithExtension(document.title, contentType))}"`,
    'cache-control': 'private, no-store',
  };
  if (object.contentLength !== null) headers['content-length'] = String(object.contentLength);
  return new NextResponse(object.body, { status: 200, headers });
}

export async function documentPreviewResponse(
  request: NextRequest,
  document: DocumentDeliverySource,
): Promise<NextResponse> {
  if (isPreviewStreamRequest(request)) {
    try {
      const preview = await loadDocumentPreview(document);
      return new NextResponse(preview.body, { status: 200, headers: preview.headers });
    } catch (error) {
      log.warn(
        {
          component: 'document-delivery',
          errName: error instanceof Error ? error.name : typeof error,
          err: error instanceof Error ? error.message : String(error),
        },
        'document-delivery: Vorschau nicht lesbar',
      );
      return NextResponse.json({ error: 'storage_unavailable' }, { status: 502 });
    }
  }

  const metadata = documentPreviewMetadata(document);
  return NextResponse.json({
    url: `${request.nextUrl.pathname}?stream=1`,
    mimeType: metadata.mimeType,
    documentMimeType: metadata.documentMimeType,
    title: metadata.title,
  });
}
