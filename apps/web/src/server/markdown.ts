// =============================================================================
// Sehr einfacher Markdown→HTML-Renderer für admin-kontrollierten Text.
//
// Geteilt zwischen Mail-Dispatch (apps/web/src/server/mail/dispatch.ts) und
// UI-Stellen wie Form-Template-introMd. Die Funktion ist BEWUSST minimal:
//   - **fett**, *kursiv*
//   - http(s)://-Autolinks mit safeHref-Attribut-Encoding (T-2)
//   - Absätze (\n\n), Zeilenumbrüche, Aufzählungslisten (- / *)
// Keine Tabellen, Bilder, raw HTML, JS-URIs. Eingabe wird zuerst HTML-escaped,
// dann mit den Inline-Mustern angereichert — alle injizierten Tags stammen
// ausschließlich aus dem Renderer, nicht aus dem User-Input.
//
// Output ist sicher für dangerouslySetInnerHTML in dem engen Kontext, dass
// der EINGABE-TEXT bereits aus einem Admin-Trust-Boundary kommt. Für
// user-supplied Variablen (z. B. Mandanten-Namen in einer Mail) MÜSSEN
// die Werte vorher durch `escapeMarkdownVariable` laufen.
// =============================================================================

function safeHref(url: string): string {
  return url.replace(/[<>"'`\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Sentinels nutzen private-use-codepoints, die in escapeMarkdownVariable aus
// User-Input gestripped werden (siehe dort). Damit kann kein User-Input
// unsere Sentinels untergraben oder vorzeitig schließen.
const SENT_STAR = '';
const SENT_USCORE = '';
const SENT_LBRACK = '';
const SENT_RBRACK = '';
const SENT_BSLASH = '';
const SENT_SCHEME_SEP = '';

/**
 * M-2: Escape-Helper für user-supplied Variablen, BEVOR sie in eine
 * Markdown-Vorlage substituiert werden. Verhindert, dass Mandanten-Inputs
 * wie „**fett**", „- Liste" oder „https://evil.example" beim Render als
 * Markdown / Autolink interpretiert werden.
 *
 * Härtungen (Round 12):
 *  - `://` wird via Sentinel zwischen `:` und `//` disarmt — Autolink-Regex
 *    matched nicht mehr, User sieht „https://" visuell unverändert
 *    (Sentinel wird im finalen Render rückstandslos entfernt).
 *  - Private-Use-Area-Codepoints (U+E000–F8FF) werden gestripped, damit
 *    User-Input die internen Sentinels nicht untergräbt.
 *  - `\` `*` `_` `[` `]` mit Backslash-Escape (renderSafeMarkdown un-escapt).
 */
export function escapeMarkdownVariable(s: string): string {
  // 1) Private-Use-Area strippen (U+E000–U+F8FF). Diese Codepoints sind
  //    für interne Sentinels reserviert.
  const clean = s.replace(/[-]/g, '');
  // 2) Markdown-Trigger-Zeichen backslash-escapen.
  const backslashed = clean.replace(/[\\*_[\]]/g, (c) => `\\${c}`);
  // 3) Autolink disarmen: zwischen `:` und `//` einen Sentinel einfügen.
  return backslashed.replace(/:\/\//g, `:${SENT_SCHEME_SEP}//`);
}

export function renderSafeMarkdown(md: string): string {
  // Defense-in-Depth: auch hier private-use raus (falls ein Aufrufer den
  // Renderer direkt mit potenziell unsicherem Input füttert — escape sollte
  // davor laufen, aber wir verlassen uns nicht darauf).
  const scrubbed = md.replace(/[-]/g, '');
  const escaped = scrubbed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // M-2: Backslash-escapte Marker via Sentinels schützen, sodass die
  // Inline-Replacements sie nicht treffen.
  const protectedText = escaped
    .replace(/\\\\/g, SENT_BSLASH)
    .replace(/\\\*/g, SENT_STAR)
    .replace(/\\_/g, SENT_USCORE)
    .replace(/\\\[/g, SENT_LBRACK)
    .replace(/\\\]/g, SENT_RBRACK);
  const withInline = protectedText
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(
      /(https?:\/\/[^\s<"'`]+)/g,
      (_, u: string) =>
        `<a href="${safeHref(u)}" target="_blank" rel="noopener noreferrer">${u}</a>`,
    );
  // M-2: Sentinel-Restore. SENT_SCHEME_SEP wird rückstandslos entfernt —
  // der eingefügte Disarm-Marker hinterlässt keine sichtbare Spur.
  const restored = withInline
    .replaceAll(SENT_STAR, '*')
    .replaceAll(SENT_USCORE, '_')
    .replaceAll(SENT_LBRACK, '[')
    .replaceAll(SENT_RBRACK, ']')
    .replaceAll(SENT_BSLASH, '\\')
    .replaceAll(SENT_SCHEME_SEP, '');
  const paragraphs = restored.split(/\n\s*\n/).map((p) => {
    const lines = p.split(/\n/);
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${lines.join('<br>')}</p>`;
  });
  return paragraphs.join('\n');
}
