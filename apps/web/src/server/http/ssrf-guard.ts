// =============================================================================
// Re-Export der gemeinsamen Implementation in @taxtronik/http-utils.
//
// Strukturelle Konsolidierung: vorher Code-Duplikation Web/Worker (H1/H3/H4-
// Patches mussten zweimal gemacht werden, N1/N2/N9 waren das Symptom).
// Single Source of Truth eliminiert die Drift-Klasse von Findings.
// =============================================================================

// K-10: Die Policy-Varianten nutzen die typisierten Signaturen des Pakets
// (HttpTargetPolicy) direkt; die früheren Signatur-Casts an der SSRF-Grenze
// sind entfallen.
import {
  assertPublicHost,
  safeFetch,
  SsrfGuardError,
  type HttpTargetPolicy,
  type N8nTargetKind,
} from '@taxtronik/http-utils';
export {
  assertPublicHost,
  safeFetch,
  SsrfGuardError,
  type HttpTargetPolicy,
  type N8nTargetKind,
} from '@taxtronik/http-utils';

const PUBLIC_TARGET: HttpTargetPolicy = { mode: 'public' };

function n8nTarget(kind: N8nTargetKind): HttpTargetPolicy {
  return { mode: 'n8n', kind };
}

export async function assertPublicUrl(url: string) {
  return await assertPublicHost(url, PUBLIC_TARGET);
}

export async function safeFetchPublic(url: string, init?: RequestInit) {
  return await safeFetch(url, init, PUBLIC_TARGET);
}

export async function assertN8nUrl(url: string, kind: N8nTargetKind) {
  return await assertPublicHost(url, n8nTarget(kind));
}

export async function safeFetchN8n(url: string, kind: N8nTargetKind, init?: RequestInit) {
  return await safeFetch(url, init, n8nTarget(kind));
}

const UNRESOLVABLE_HOST_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);

/**
 * F-03: UI-taugliche Meldung für eine abgewiesene oder nicht auflösbare
 * Ziel-URL — eingeordnet über Fehlerklasse bzw. DNS-Fehlercode, nie über den
 * Meldungstext. `null`, wenn der Fehler keine Ziel-URL-Prüfung betrifft.
 */
export function urlTargetErrorMessage(error: unknown): string | null {
  if (error instanceof SsrfGuardError) return error.message;
  const code =
    error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && UNRESOLVABLE_HOST_CODES.has(code)) {
    return 'Hostname ist nicht auflösbar.';
  }
  return null;
}
