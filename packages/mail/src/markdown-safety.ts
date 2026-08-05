// =============================================================================
// Client-sichere Markdown->HTML-Primitiven.
//
// Keine Node-/Server-Abhaengigkeiten: Wissensartikel im UI und serverseitige
// Mail-/Formular-Renderer verwenden damit dieselbe XSS-Haertung.
// =============================================================================

/** Escaped Text fuer HTML-Inhalt und quotierte HTML-Attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_HREF = /^(?:https?:|mailto:|\/(?!\/))/i;
const HREF_BREAKER_CODE_POINTS = new Set([0x22, 0x27, 0x3c, 0x3e, 0x5c, 0x60]);

/**
 * Erlaubt nur HTTP(S), mailto und lokale absolute Pfade. Zeichen, die ein
 * quotiertes href-Attribut oder nachgelagerte Parser irritieren koennten,
 * werden percent-encoded. Nicht erlaubte Ziele werden inert.
 */
export function safeHref(url: string): string {
  if (!ALLOWED_HREF.test(url)) return '#';
  return Array.from(url, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!HREF_BREAKER_CODE_POINTS.has(codePoint) && codePoint > 0x1f && codePoint !== 0x7f) {
      return char;
    }
    return `%${codePoint.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}
