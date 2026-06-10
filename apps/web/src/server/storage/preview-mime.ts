// =============================================================================
// MIME-Whitelist für `Content-Disposition: inline`.
//
// Hintergrund: Beim Upload validiert das Schema nur, dass `mimeType` ein
// beliebiger String ist. Ein böser Mandant könnte text/html hochladen und
// dann über die Preview-URL ausführen lassen — wenn S3-Endpoint und App
// dieselbe Origin teilen, ist das Stored-XSS. Selbst bei separater Origin
// ist es ein Phishing-Vektor.
//
// Strategie: nur PDF, Bilder und Plain-Text inline ausliefern. Alles andere
// erzwingt `attachment`, damit der Browser herunterlädt statt rendert.
// =============================================================================

import { sanitizeFilenameForHeader } from '@taxtronik/storage';

// Bewusst NICHT enthalten:
//  - text/html, application/xhtml+xml — würden gerendert werden
//  - image/svg+xml — kann <script> ausführen
//  - application/javascript, application/xml mit Stylesheet — XSS-Risiko
const INLINE_MIME_WHITELIST = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

// MIME → Dateiendung. Beim Upload strippt das Formular die Endung aus dem
// Titel (Titel ist ein Anzeigename), und der Storage-Key endet generisch auf
// `.bin`. Ohne Rückableitung lädt der Browser die Datei ohne Endung herunter
// und Windows/macOS wissen nicht, womit sie zu öffnen ist. Darum aus der
// MIME die kanonische Endung ergänzen.
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/xml': 'xml',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/**
 * Stellt sicher, dass `name` eine zur `mimeType` passende Endung trägt.
 * Hat der Name bereits die korrekte Endung (case-insensitive), bleibt er
 * unverändert. Unbekannte MIME → Name unverändert (kein erratenes `.bin`).
 */
export function filenameWithExtension(name: string, mimeType: string | null | undefined): string {
  const base = name.trim() || 'download';
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase();
  const ext = normalized ? MIME_TO_EXT[normalized] : undefined;
  if (!ext) return base;
  if (base.toLowerCase().endsWith(`.${ext}`)) return base;
  return `${base}.${ext}`;
}

export function isInlineSafeMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase();
  if (!normalized) return false;
  return INLINE_MIME_WHITELIST.has(normalized);
}

/**
 * Liefert den Content-Disposition-Header für Preview-Responses. Wenn die
 * MIME-Type nicht in der Inline-Whitelist ist, wird `attachment` erzwungen,
 * sodass der Browser herunterlädt statt rendert.
 */
export function previewDisposition(mimeType: string, fileName: string): string {
  // N6: identische Sanitizer-Whitelist wie storage/service.ts
  // (sanitizeFilenameForHeader) — vorher strippte preview-mime nur \r\n",
  // service strippte zusätzlich Backslash + Control-Chars. Jetzt eine Quelle.
  const safeName = sanitizeFilenameForHeader(filenameWithExtension(fileName, mimeType));
  const mode = isInlineSafeMime(mimeType) ? 'inline' : 'attachment';
  return `${mode}; filename="${safeName}"`;
}

/**
 * Wenn die MIME-Type unsicher ist, fällt der Content-Type auf
 * `application/octet-stream` zurück — verhindert, dass der Browser
 * trotz attachment beim Direkt-Aufruf der Signed-URL den Header
 * ignoriert und doch rendert.
 */
export function previewContentType(mimeType: string): string {
  return isInlineSafeMime(mimeType) ? mimeType : 'application/octet-stream';
}

/**
 * Zusätzliche Sicherheits-Header für die Stream-Response (Audit 2026-06
 * Befund 4): `text/plain` wird inline ausgeliefert und hängt sonst allein an
 * `X-Content-Type-Options: nosniff` — würde der Browser den Inhalt doch als
 * HTML interpretieren, wäre das Stored-XSS. `CSP: sandbox` nimmt dem Dokument
 * Skript-Ausführung und gibt ihm eine opaque Origin (keine Cookies/Storage
 * der App), egal wie der Browser den Inhalt deutet.
 *
 * Bewusst NUR für text/plain: PDFs brauchen den (teils geprivilegierten)
 * Browser-Viewer, den `sandbox` in Chromium blockieren kann; Bilder sind
 * magic-byte-validiert und führen nichts aus.
 */
export function previewSecurityHeaders(mimeType: string): Record<string, string> {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'text/plain') {
    return { 'content-security-policy': 'sandbox' };
  }
  return {};
}
