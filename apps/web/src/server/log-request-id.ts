// =============================================================================
// Request-ID je eingehendem Web-Request (Review-Befund F-06).
//
// Der Proxy (proxy.ts) vergibt die ID, reicht sie als Request-Header an Server
// Components, Server Actions und Route Handler weiter und gibt sie als
// Response-Header zurück; der Logger (log-context.ts) schreibt sie in jede
// Zeile. Bewusst abhängigkeitsfrei, weil der Proxy dieses Modul bündelt.
// =============================================================================

/** Request- und Response-Header der Request-ID. */
export const REQUEST_ID_HEADER = 'x-request-id';

// Übernommen wird nur, was keinen Freitext tragen kann: eine UUID (Caddy,
// Envoy, Heroku) oder 16–64 Hex-Zeichen (nginx `$request_id`). Namen,
// E-Mail-Adressen oder Client-IPs (etwa aus einem HAProxy-`unique-id-format`)
// passen in keines der beiden Formate, CR/LF und Listen ("a, b") ebenso wenig.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TOKEN_PATTERN = /^[0-9a-f]{16,64}$/i;

/** Wohlgeformte, längenbegrenzte Request-ID ohne Freitext. */
export function isWellFormedRequestId(value: unknown): value is string {
  return typeof value === 'string' && (UUID_PATTERN.test(value) || HEX_TOKEN_PATTERN.test(value));
}

/**
 * Übernimmt eine wohlgeformte eingehende ID (Korrelation mit dem Log des
 * Reverse-Proxys), sonst eine neue zufällige UUID.
 */
export function resolveRequestId(incoming: string | null | undefined): string {
  return isWellFormedRequestId(incoming) ? incoming : crypto.randomUUID();
}
