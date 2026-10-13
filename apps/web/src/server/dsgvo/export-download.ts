// =============================================================================
// Download eines im Worker erzeugten DSGVO-Kontaktpakets (Welle 15, P-11).
//
// Fachkatalog: DSGVO-CONTACT-EXPORT-001, DSGVO-REQUEST-EVIDENCE-001
//
// Ausgeliefert wird nur das Paket, das als Ergebnis am Antrag gebunden ist
// (SHA-256 gleich dsgvo_request.result_sha256), aus genau der gespeicherten
// Objektversion und erst nach bestandener Größen- und Hash-Prüfung. Jeder
// Download steht als dsgvo.export.download in der Audit-Chain.
// =============================================================================

import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { fetchVerifiedObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';

export class DsgvoExportUnavailableError extends Error {
  constructor(message = 'Kein abrufbares Paket für diesen Antrag.') {
    super(message);
    this.name = 'DsgvoExportUnavailableError';
  }
}

export interface DsgvoExportDownload {
  bytes: Buffer;
  filename: string;
  sha256: string;
}

export interface DsgvoExportDownloadDeps {
  inTenant<T>(ctx: TenantContext, fn: (tx: TxClient) => Promise<T>): Promise<T>;
  fetchVerified: typeof fetchVerifiedObjectBytes;
  record(tx: TxClient, event: Parameters<typeof evidenceService.record>[1]): Promise<unknown>;
}

const defaultDeps: DsgvoExportDownloadDeps = {
  inTenant: (ctx, fn) => withTenantContext(ctx, fn),
  fetchVerified: fetchVerifiedObjectBytes,
  record: (tx, event) => evidenceService.record(tx, event),
};

/** Dateiname wie beim früheren Browser-Download des Pakets. */
export function dsgvoExportFilename(subjectName: string, generatedAt: Date): string {
  return `dsgvo-auskunft-${subjectName.replace(/\s+/g, '-')}-${generatedAt.toISOString().slice(0, 10)}.json`;
}

export async function loadDsgvoExportDownload(
  ctx: TenantContext & { actorId: string },
  requestId: string,
  deps: DsgvoExportDownloadDeps = defaultDeps,
): Promise<DsgvoExportDownload> {
  const located = await deps.inTenant(ctx, async (tx) => {
    const request = await tx.dsgvoRequest.findFirst({
      where: { id: requestId, tenantId: ctx.tenantId },
      select: { id: true, subjectName: true, resultSha256: true, resultPreparedAt: true },
    });
    if (!request?.resultSha256) return null;
    const current = await tx.dsgvoExport.findFirst({
      where: { requestId: request.id, status: 'DONE', objectDeletedAt: null },
      orderBy: { finishedAt: 'desc' },
      select: {
        id: true,
        storageBucket: true,
        storageKey: true,
        storageVersionId: true,
        sha256: true,
        sizeBytes: true,
        finishedAt: true,
      },
    });
    if (
      !current?.sha256 ||
      !current.storageBucket ||
      !current.storageKey ||
      current.sizeBytes === null ||
      !Buffer.from(current.sha256).equals(Buffer.from(request.resultSha256))
    ) {
      return null;
    }
    return { request, current };
  });
  if (!located) throw new DsgvoExportUnavailableError();
  const { request, current } = located;
  const sha256 = Buffer.from(current.sha256!).toString('hex');
  const bytes = await deps.fetchVerified(
    {
      bucket: current.storageBucket!,
      key: current.storageKey!,
      versionId: current.storageVersionId,
    },
    { sizeBytes: current.sizeBytes, sha256: current.sha256 },
  );
  await deps.inTenant(ctx, (tx) =>
    deps.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'dsgvo.export.download',
      resourceType: 'dsgvo_request',
      resourceId: request.id,
      after: { exportId: current.id, sha256 },
    }),
  );
  return {
    bytes,
    sha256,
    filename: dsgvoExportFilename(
      request.subjectName,
      request.resultPreparedAt ?? current.finishedAt ?? new Date(),
    ),
  };
}
