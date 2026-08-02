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
    return NAMED_ENTITIES[body] ?? match;
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

    // Kommentare, CDATA, Doctype und Deklarationen
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      pos = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const raw = xml.slice(lt + 9, end === -1 ? len : end);
      if (raw && onText) onText(raw);
      pos = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      pos = end === -1 ? len : end + 1;
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

const ATTRIBUTE = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): XmlAttributes {
  const attrs: Record<string, string> = {};
  if (!source.trim()) return attrs;
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const raw = match[3] ?? match[4] ?? '';
    attrs[stripNamespace(match[1]!)] = decodeXmlEntities(raw);
  }
  return attrs;
}
