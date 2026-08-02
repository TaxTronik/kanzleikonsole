/**
 * Nur Formate zulassen, deren Viewer keine fremden aktiven Inhalte in den
 * authentifizierten App-DOM übernimmt. DOCX fällt deshalb immer auf den
 * Download-Pfad zurück.
 */
export function detectInlineOfficeKind(mimeType: string | null, fileName: string): 'xlsx' | null {
  if (mimeType?.includes('spreadsheetml.sheet')) return 'xlsx';
  if (fileName.toLowerCase().endsWith('.xlsx')) return 'xlsx';
  return null;
}

/**
 * Entscheidet, ob neben dem Download auch ein Auge angeboten wird.
 *
 * Bewusst NICHT enthalten: `application/xml`. XRechnung-Dateien blieben sonst
 * ohne Darstellung („Keine Inline-Vorschau"), denn `application/xml` steht aus
 * XSS-Gründen nicht in der Inline-Whitelist (server/storage/preview-mime.ts).
 * Menschenlesbar ist bei diesen Rechnungen das ZUGFeRD-PDF derselben Rechnung.
 * Ein Auge, das nur eine Fehlmeldung öffnet, ist schlechter als keins.
 */
export function canPreviewInline(mimeType: string | null, fileName: string): boolean {
  const m = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (m === 'application/pdf' || m.endsWith('/pdf')) return true;
  if (m.startsWith('image/')) return true;
  if (m === 'text/plain' || m === 'text/markdown') return true;
  return detectInlineOfficeKind(mimeType, fileName) !== null;
}
