import type { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';

import { withTenantContext, type ActorType, type TxClient } from '@taxtronik/db';
import { sanitizeFilenameForHeader, streamObject } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { getClientIp } from '@/server/rate-limit';
import { documentPreviewMetadata, loadDocumentPreview } from '@/server/storage/document-preview';
import { effectiveDocumentMime, filenameWithExtension } from '@/server/storage/preview-mime';

export interface DocumentDeliverySource {
  title: string;
  mimeType: string;
  classification: string;
  clientId: string | null;
  bucket: string;
  key: string;
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
          select: { storageBucket: true, storageKey: true },
        },
      },
    });
    const version = candidate?.versions[0];
    if (!candidate || !version) return null;
    if (candidate.requiresPayrollAccess) {
      if (options.actorType !== 'STAFF') return null;
      const allowed = await tx.$queryRaw<
        Array<{ allowed: boolean }>
      >`SELECT app.expansion_staff_permission(${options.tenantId}::uuid,${options.actorId}::uuid,'PAYROLL_MANAGE') AS allowed`;
      if (allowed[0]?.allowed !== true) return null;
    }
    if (options.authorize && !(await options.authorize(tx, candidate))) return null;

    if (!ignoreAuditFailure) await recordAccess(tx, options);

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
      isPoaDocument: Boolean(powerOfAttorney),
    };
  });

  if (document && ignoreAuditFailure) {
    // Eigene Transaktion: Ein SQL-Fehler setzt eine Postgres-Transaktion auf
    // aborted. Nur die Trennung macht "Preview trotz Audit-Fehler" wirklich
    // best effort, statt den anschliessenden Commit doch scheitern zu lassen.
    await withTenantContext(ctx, (tx) => recordAccess(tx, options)).catch(() => undefined);
  }

  return document;
}

export async function documentDownloadResponse(
  document: DocumentDeliverySource,
  options: { mimeSource: 'validated-document' | 'storage-when-present' },
): Promise<NextResponse> {
  const object = await streamObject(document.bucket, document.key);
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
  if (request.nextUrl.searchParams.get('stream') === '1') {
    try {
      const preview = await loadDocumentPreview(document);
      return new NextResponse(new Uint8Array(preview.bytes), {
        status: 200,
        headers: preview.headers,
      });
    } catch {
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
