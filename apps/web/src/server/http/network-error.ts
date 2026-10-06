// =============================================================================
// Netzwerkfehler (fetch/undici, DNS, Sockets, Timeouts) über Fehlername bzw.
// System-Fehlercode einordnen statt über den Meldungstext (Review-Befund F-03).
// =============================================================================

export type NetworkFailure = { kind: 'timeout' } | { kind: 'unreachable'; code: string | null };

/** Node-System- und undici-Codes; Prisma-Codes (P2002 …) fallen bewusst nicht darunter. */
const NETWORK_CODE = /^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/;
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function networkCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_CODE.test(code) ? code : null;
}

/** Zeitüberschreitung oder nicht erreichbares Ziel; `null` für alle anderen Fehler. */
export function networkFailure(error: unknown): NetworkFailure | null {
  if (!(error instanceof Error)) return null;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return { kind: 'timeout' };
  const code = networkCode(error) ?? networkCode(error.cause);
  if (code && TIMEOUT_CODES.has(code)) return { kind: 'timeout' };
  if (code) return { kind: 'unreachable', code };
  // undici wirft `TypeError('fetch failed', { cause })`; ohne Code ist dieser
  // dokumentierte Wortlaut die einzige Kennung.
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return { kind: 'unreachable', code: null };
  }
  return null;
}
