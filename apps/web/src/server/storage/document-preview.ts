import {
  detectMimeFromMagicBytes,
  fetchObjectHead,
  streamVerifiedObject,
  type StoredObjectRef,
} from '@taxtronik/storage';
import {
  effectiveDocumentMime,
  previewContentType,
  previewDisposition,
  previewSecurityHeaders,
} from './preview-mime';

export interface PreviewDocumentSource {
  mimeType: string;
  title: string;
  classification: string;
  bucket: string;
  key: string;
  storageVersionId?: string | null;
  /** Gebundene Fassung; wird beim Ausliefern immer gegen den Objektinhalt geprüft (R-05). */
  sha256: Uint8Array;
  sizeBytes: bigint;
  isPoaDocument: boolean;
}

export function documentPreviewMetadata(doc: PreviewDocumentSource): {
  mimeType: string;
  documentMimeType: string;
  title: string;
} {
  return {
    // `mimeType` ist der Transport-Typ: alles ausserhalb der Inline-Whitelist
    // faellt auf octet-stream, damit der Browser nichts Fremdes rendert.
    mimeType: effectiveDocumentMime(doc),
    // `documentMimeType` ist der tatsaechlich gespeicherte Typ und steuert
    // ausschliesslich, welchen eigenen Viewer der Client waehlt. Er darf keine
    // Auslieferungsentscheidung beeinflussen — sonst waere die Whitelist
    // umgangen.
    documentMimeType: doc.mimeType,
    title: doc.title,
  };
}

/**
 * R-05: Der Dateityp ergibt sich aus den Magic Bytes am Dateianfang — ein
 * Range-Request auf die ersten KB statt die ganze Datei (bis 25 MiB) zu laden.
 * Die Bytes selbst werden danach gestreamt und gegen Größe/SHA-256 der
 * gebundenen Fassung geprüft.
 */
export async function loadDocumentPreview(doc: PreviewDocumentSource): Promise<{
  body: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
}> {
  const metadataMime = effectiveDocumentMime(doc);
  const ref: StoredObjectRef = {
    bucket: doc.bucket,
    key: doc.key,
    versionId: doc.storageVersionId,
  };
  const head = await fetchObjectHead(ref);
  const detected = detectMimeFromMagicBytes(head);
  const detectedMime = detected
    ? previewContentType(detected, doc.title)
    : 'application/octet-stream';
  const contentType = detectedMime !== 'application/octet-stream' ? detectedMime : metadataMime;
  const dispositionMime = contentType === 'application/octet-stream' ? doc.mimeType : contentType;

  const object = await streamVerifiedObject(ref, { sizeBytes: doc.sizeBytes, sha256: doc.sha256 });

  return {
    body: object.body,
    headers: {
      'content-type': contentType,
      'content-disposition': previewDisposition(dispositionMime, doc.title),
      'cache-control': 'private, no-store',
      ...previewSecurityHeaders(dispositionMime, doc.title),
      ...(object.contentLength !== null ? { 'content-length': String(object.contentLength) } : {}),
    },
  };
}
