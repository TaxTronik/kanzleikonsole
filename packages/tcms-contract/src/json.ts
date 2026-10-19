// =============================================================================
// Strenges JSON-Lesen für Akteursbestätigung und Anfrage-Bodys.
//
// `JSON.parse` behält bei doppelten Schlüsseln stillschweigend den letzten
// Wert und legt `__proto__` als eigene Eigenschaft an, die zod im strikten
// Modus nicht als unbekanntes Feld meldet. Beides weist dieses Modul ab, damit
// kanzleikonsole und Dienst dieselben Bytes nicht verschieden deuten.
// =============================================================================

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type JsonErgebnis =
  | { ok: true; wert: unknown }
  | { ok: false; grund: 'UTF8' | 'JSON' | 'SCHLUESSEL' };

/**
 * UTF-8 (strikt, ein BOM bleibt ein Fehler) → JSON → keine doppelten
 * Schlüssel und kein `__proto__` in irgendeinem Objekt.
 */
export function parseJsonStrikt(bytes: Uint8Array): JsonErgebnis {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { ok: false, grund: 'UTF8' };
  }
  let wert: unknown;
  try {
    wert = JSON.parse(text);
  } catch {
    return { ok: false, grund: 'JSON' };
  }
  if (!schluesselEindeutig(text)) return { ok: false, grund: 'SCHLUESSEL' };
  return { ok: true, wert };
}

/** Wie `parseJsonStrikt`, verlangt zusätzlich ein Objekt (kein Array, kein null). */
export function parseJsonObjektStrikt(bytes: Uint8Array): Record<string, unknown> | null {
  const e = parseJsonStrikt(bytes);
  if (!e.ok || typeof e.wert !== 'object' || e.wert === null || Array.isArray(e.wert)) return null;
  return e.wert as Record<string, unknown>;
}

/**
 * Prüft die Schlüssel aller Objekte eines bereits gültigen JSON-Texts: keine
 * Dubletten und kein `__proto__`. Schlüssel werden dekodiert verglichen, damit
 * eine Schreibweise mit Unicode-Escape nicht als anderer Schlüssel gilt.
 * Iterativ, damit tiefe Verschachtelung den Stack nicht sprengt.
 */
function schluesselEindeutig(text: string): boolean {
  const stapel: (Set<string> | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const zeichen = text[i];
    if (zeichen === '"') {
      let ende = i + 1;
      while (ende < text.length && text[ende] !== '"') ende += text[ende] === '\\' ? 2 : 1;
      const literal = text.slice(i, ende + 1);
      i = ende + 1;
      let k = i;
      while (text[k] === ' ' || text[k] === '\t' || text[k] === '\n' || text[k] === '\r') k++;
      const objekt = stapel[stapel.length - 1];
      if (text[k] === ':' && objekt) {
        const schluessel = JSON.parse(literal) as string;
        if (schluessel === '__proto__' || objekt.has(schluessel)) return false;
        objekt.add(schluessel);
      }
      continue;
    }
    if (zeichen === '{') stapel.push(new Set());
    else if (zeichen === '[') stapel.push(null);
    else if (zeichen === '}' || zeichen === ']') stapel.pop();
    i++;
  }
  return true;
}
