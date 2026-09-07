// =============================================================================
// Minimaler XML-Tokenizer fuer OOXML-Teile (SpreadsheetML).
//
// Bewusst kein XML-Framework: Die Teile eines XLSX sind maschinenerzeugt und
// brauchen weder Namespace-Aufloesung noch DTD/Entity-Definitionen. Der Scanner
// laeuft in Node und im Browser identisch und zieht keine Transitiv-Deps nach.
//
// Nicht unterstuetzt (in OOXML nicht zulaessig bzw. nicht benoetigt):
// Doctype-Subsets, benutzerdefinierte Entities, Processing-Instructions mit
// Bedeutung. Diese werden ueberlesen statt interpretiert.
// =============================================================================

export type XmlAttributes = Readonly<Record<string, string>>;

export interface XmlHandlers {
  /** `<tag …>` und `<tag …/>`; bei Self-Closing folgt sofort `onClose`. */
  onOpen?: (name: string, attrs: XmlAttributes) => void;
  onClose?: (name: string) => void;
  /** Textknoten und CDATA-Inhalte, bereits entity-dekodiert. */
  onText?: (text: string) => void;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Dekodiert die in OOXML zulaessigen Entities inkl. numerischer Referenzen. */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body]! : match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Laeuft einmal linear ueber das Dokument und meldet Tags und Text.
 * Wohlgeformtheit wird nicht erzwungen — unbekannte Konstrukte werden
 * uebersprungen, damit ein defektes Fremd-Export nicht zum Absturz fuehrt.
 */
export function parseXml(xml: string, handlers: XmlHandlers): void {
  const { onOpen, onClose, onText } = handlers;
  let pos = 0;
  const len = xml.length;

  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      emitText(xml.slice(pos));
      return;
    }
    if (lt > pos) emitText(xml.slice(pos, lt));

    const specialEnd = skipSpecialMarkup(xml, lt, onText);
    if (specialEnd !== null) {
      pos = specialEnd;
      continue;
    }

    const tagEnd = findTagEnd(xml, lt + 1);
    if (tagEnd === -1) return;
    const inner = xml.slice(lt + 1, tagEnd);
    pos = tagEnd + 1;

    if (inner.startsWith('/')) {
      onClose?.(stripNamespace(inner.slice(1).trim()));
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = findNameEnd(body);
    const name = stripNamespace(body.slice(0, nameEnd));
    if (!name) continue;

    if (onOpen) onOpen(name, parseAttributes(body.slice(nameEnd)));
    if (selfClosing) onClose?.(name);
  }

  function emitText(raw: string): void {
    if (!raw || !onText) return;
    onText(decodeXmlEntities(raw));
  }
}

/** Kommentare/Deklarationen überspringen; CDATA ohne Entity-Dekodierung melden. */
function skipSpecialMarkup(
  xml: string,
  from: number,
  onText: XmlHandlers['onText'],
): number | null {
  if (xml.startsWith('<!--', from)) {
    const end = xml.indexOf('-->', from + 4);
    return end === -1 ? xml.length : end + 3;
  }
  if (xml.startsWith('<![CDATA[', from)) {
    const end = xml.indexOf(']]>', from + 9);
    const raw = xml.slice(from + 9, end === -1 ? xml.length : end);
    if (raw) onText?.(raw);
    return end === -1 ? xml.length : end + 3;
  }
  if (xml.startsWith('<?', from) || xml.startsWith('<!', from)) {
    const end = xml.indexOf('>', from + 2);
    return end === -1 ? xml.length : end + 1;
  }
  return null;
}

/** Findet das `>`, das das Tag schliesst — Anfuehrungszeichen werden respektiert. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function findNameEnd(body: string): number {
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return i;
  }
  return body.length;
}

/** `r:id` -> `id`. Namespace-Praefixe sind in XLSX-Teilen eindeutig genug. */
function stripNamespace(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function parseAttributes(source: string): XmlAttributes {
  // Consume each candidate once. A searching regex would retry every suffix
  // of a long malformed name without `=`, causing quadratic backtracking.
  const attrs: Record<string, string> = {};
  let pos = 0;
  while (pos < source.length) {
    pos = skipAttributeWhitespace(source, pos);
    const nameStart = pos;
    while (pos < source.length && !/[\s=/]/.test(source[pos]!)) pos++;
    if (pos === nameStart) {
      pos++;
      continue;
    }
    const name = stripNamespace(source.slice(nameStart, pos));
    pos = skipAttributeWhitespace(source, pos);
    if (source[pos] !== '=') continue;
    pos = skipAttributeWhitespace(source, pos + 1);
    const quote = source[pos];
    if (quote !== '"' && quote !== "'") continue;
    const end = source.indexOf(quote, pos + 1);
    if (end === -1) break;
    attrs[name] = decodeXmlEntities(source.slice(pos + 1, end));
    pos = end + 1;
  }
  return attrs;
}

function skipAttributeWhitespace(source: string, from: number): number {
  let pos = from;
  while (pos < source.length && /\s/.test(source[pos]!)) pos++;
  return pos;
}
