import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { TxClient } from '@taxtronik/db';
import { fetchObjectBytes } from '@taxtronik/storage';
import { IdentityViewportsSchema, type IdentityViewport } from '@/lib/gwg/identity-viewport';

export async function loadIdentitySourceTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    documentId: string;
  },
) {
  const document = await tx.document.findFirst({
    where: {
      id: input.documentId,
      tenantId: input.tenantId,
      clientId: input.clientId,
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      gwgDestroyedAt: null,
      gwgDestructionRequestedAt: null,
    },
    select: {
      id: true,
      title: true,
      mimeType: true,
      versions: {
        orderBy: { versionNo: 'desc' },
        take: 1,
        select: {
          id: true,
          storageBucket: true,
          storageKey: true,
          storageVersionId: true,
          scanStatus: true,
          scanCompletedAt: true,
          sha256: true,
          sizeBytes: true,
        },
      },
    },
  });
  const version = document?.versions[0];
  if (
    !document ||
    !version ||
    version.scanStatus !== 'CLEAN' ||
    !version.scanCompletedAt ||
    !version.storageVersionId ||
    version.sizeBytes > BigInt(25 * 1024 * 1024)
  )
    return null;
  return { documentId: document.id, title: document.title, mimeType: document.mimeType, version };
}
export type IdentitySource = NonNullable<Awaited<ReturnType<typeof loadIdentitySourceTx>>>;

export async function readIdentitySourceBytes(source: IdentitySource): Promise<Buffer> {
  const bytes = await fetchObjectBytes(source.version.storageBucket, source.version.storageKey);
  const digest = createHash('sha256').update(bytes).digest();
  if (BigInt(bytes.length) !== source.version.sizeBytes || !digest.equals(source.version.sha256)) {
    throw new Error('Die Originaldatei stimmt nicht mit der gebundenen Version überein.');
  }
  return bytes;
}

/** GWG-IDENTIFICATION-EVIDENCE-001: caller must hold document/lifecycle locks. */
export async function validateIdentityViewportsTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    documentId: string;
    views: IdentityViewport[];
  },
): Promise<IdentityViewport[]> {
  const views = IdentityViewportsSchema.parse(input.views);
  if (!views.length) return [];
  const source = await loadIdentitySourceTx(tx, input);
  if (!source || views.some((view) => view.versionId !== source.version.id)) {
    throw new Error(
      'Die Ausweisdatei wurde geändert oder ist nicht verfügbar. Bitte neu auswählen.',
    );
  }
  let pages = 1;
  if (source.mimeType === 'application/pdf') {
    // A manual full-original reference needs no PDF decoding. Explicit crops,
    // rotation and later pages still require validation against the source PDF.
    const manualOriginal = views.every(
      (view) =>
        view.page === 1 &&
        view.x === 0 &&
        view.y === 0 &&
        view.width === 1 &&
        view.height === 1 &&
        view.rotation === 0,
    );
    if (!manualOriginal) {
      const pdf = await PDFDocument.load(await readIdentitySourceBytes(source), {
        updateMetadata: false,
      });
      pages = pdf.getPageCount();
    }
  } else if (!['image/jpeg', 'image/png', 'image/webp'].includes(source.mimeType)) {
    throw new Error('Ausschnitte sind nur bei JPG, PNG und PDF verfügbar.');
  }
  if (views.some((view) => view.page > pages))
    throw new Error('Die gewählte PDF-Seite existiert nicht.');
  return views;
}
