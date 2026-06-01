// =============================================================================
// Dokument -> Klartext für den Subsumtions-Workspace.
//
// Extrahiert den Text aus PDF (unpdf) und Word-.docx (mammoth), damit der
// Berater einen Sachverhalt nicht abtippen muss. Der extrahierte Text ist nur
// ein EDITOR-SEED — analysiert (und gehasht) wird am Ende der vom Berater final
// bearbeitete Text. Reine Transformation; kein DB-/Netzwerk-Zugriff.
//
// Für bereits hochgeladene Mandanten-Dokumente liefert
// `fetchObjectBytes(bucket, storageKey)` (@taxtronik/storage) die Bytes; der
// Aufrufer wählt den Bucket via getBucketForClassification/Tier.
// =============================================================================

import mammoth from 'mammoth';
import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf';

export class UnsupportedDocumentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDocumentTypeError';
  }
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

// Geschütztes Leerzeichen (U+00A0) -> normales Leerzeichen, ohne literales
// Sonderzeichen in der Quelle.
const NBSP = String.fromCharCode(0xa0);

/** Normalisiert Zeilenenden + geschützte Leerzeichen; trimmt Rand-Whitespace. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(NBSP)
    .join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Extrahiert Klartext aus `bytes`. Unterstützt PDF, .docx und text/*.
 * Wirft `UnsupportedDocumentTypeError` für alles andere (inkl. Alt-.doc).
 */
export async function extractText(bytes: Buffer, mime: string): Promise<string> {
  const m = mime.split(';')[0]!.trim().toLowerCase();

  if (m === PDF_MIME) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await unpdfExtractText(pdf, { mergePages: true });
    return normalize(text);
  }

  if (m === DOCX_MIME) {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return normalize(value);
  }

  if (m === DOC_MIME) {
    throw new UnsupportedDocumentTypeError(
      'Das alte .doc-Format wird nicht unterstützt — bitte als .docx oder PDF speichern.',
    );
  }

  if (m.startsWith('text/')) {
    return normalize(bytes.toString('utf-8'));
  }

  throw new UnsupportedDocumentTypeError(`Nicht unterstützter Dokumenttyp: ${mime}`);
}
