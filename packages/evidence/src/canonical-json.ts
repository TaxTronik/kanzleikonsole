// =============================================================================
// Kanonische JSON-Serialisierung für Hash-Chain.
//
// Wichtig: zwei semantisch gleiche Objekte MÜSSEN dieselbe Byte-Repräsentation
// haben — sonst bricht die Hash-Chain bei Re-Verifikation.
//
// Regeln:
//   - Objekt-Keys alphabetisch sortiert
//   - Keine Whitespaces zwischen Tokens
//   - Strings UTF-8, JSON-escaped
//   - Numbers als JS-Zahlen (Vorsicht bei großen Ints — wir verwenden BigInt-IDs)
//   - undefined wird ausgelassen, null bleibt erhalten
//   - Date wird als ISO-8601-String mit ms serialisiert
//   - Bytea/Buffer wird als hex-String mit Präfix "hex:" serialisiert
//
// Diese Implementierung ist bewusst minimal und ohne externe Abhängigkeit
// (jede Abhängigkeit ist ein Compliance-Risiko).
// =============================================================================

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return stringify(toJsonValue(value));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: NaN/Infinity sind nicht erlaubt');
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return 'hex:' + Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === 'object') {
    // Every own JSON key is evidence, including __proto__. A normal object
    // would invoke its inherited setter and silently omit that persisted key.
    const out: { [k: string]: JsonValue } = Object.create(null);
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        out[k] = toJsonValue(v);
      }
    }
    return out;
  }
  throw new Error(`canonicalJson: nicht-serialisierbarer Typ ${typeof value}`);
}

function stringify(v: JsonValue): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(stringify).join(',') + ']';
  // Object
  const keys = Object.keys(v); // bereits sortiert in toJsonValue
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stringify(v[k]!)).join(',') + '}';
}
