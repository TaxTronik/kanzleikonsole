// =============================================================================
// Re-Export der gemeinsamen Implementation in @taxtronik/http-utils.
//
// Strukturelle Konsolidierung: vorher Code-Duplikation Web/Worker (H1/H3/H4-
// Patches mussten zweimal gemacht werden, N1/N2/N9 waren das Symptom).
// Single Source of Truth eliminiert die Drift-Klasse von Findings.
// =============================================================================

import {
  assertPublicHost as sharedAssertPublicHost,
  safeFetch as sharedSafeFetch,
} from '@taxtronik/http-utils';
export { SsrfGuardError } from '@taxtronik/http-utils';

export type N8nTargetKind = 'api' | 'webhook' | 'webhook-test' | 'health';
type TargetPolicy =
  | { mode: 'trusted-internal' }
  | { mode: 'public' }
  | { mode: 'n8n'; kind: N8nTargetKind };

const assertWithPolicy = sharedAssertPublicHost as unknown as (
  url: string,
  policy?: TargetPolicy,
) => Promise<Array<{ address: string; family: number }>>;
const fetchWithPolicy = sharedSafeFetch as unknown as (
  url: string,
  init?: RequestInit,
  policy?: TargetPolicy,
) => Promise<Response>;

export const assertPublicHost = sharedAssertPublicHost;
export const safeFetch = sharedSafeFetch;

export async function assertPublicUrl(url: string) {
  return await assertWithPolicy(url, { mode: 'public' });
}

export async function safeFetchPublic(url: string, init?: RequestInit) {
  return await fetchWithPolicy(url, init, { mode: 'public' });
}

export async function assertN8nUrl(url: string, kind: N8nTargetKind) {
  return await assertWithPolicy(url, { mode: 'n8n', kind });
}

export async function safeFetchN8n(url: string, kind: N8nTargetKind, init?: RequestInit) {
  return await fetchWithPolicy(url, init, { mode: 'n8n', kind });
}
