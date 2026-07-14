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
