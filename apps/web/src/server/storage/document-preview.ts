import { detectMimeFromMagicBytes, fetchObjectBytes } from '@taxtronik/storage';
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
  isPoaDocument: boolean;
}

export function documentPreviewMetadata(doc: PreviewDocumentSource): {
  mimeType: string;
  title: string;
} {
  return { mimeType: effectiveDocumentMime(doc), title: doc.title };
}

export async function loadDocumentPreview(doc: PreviewDocumentSource): Promise<{
  bytes: Buffer;
  headers: Record<string, string>;
}> {
  const metadataMime = effectiveDocumentMime(doc);
  const bytes = await fetchObjectBytes(doc.bucket, doc.key);
  const detected = detectMimeFromMagicBytes(bytes);
  const detectedMime = detected
    ? previewContentType(detected, doc.title)
    : 'application/octet-stream';
  const contentType = detectedMime !== 'application/octet-stream' ? detectedMime : metadataMime;
  const dispositionMime = contentType === 'application/octet-stream' ? doc.mimeType : contentType;

  return {
    bytes,
    headers: {
      'content-type': contentType,
      'content-disposition': previewDisposition(dispositionMime, doc.title),
      'cache-control': 'private, no-store',
      ...previewSecurityHeaders(dispositionMime, doc.title),
      'content-length': String(bytes.length),
    },
  };
}
