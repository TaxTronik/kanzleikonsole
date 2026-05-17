// =============================================================================
// Re-Export der gemeinsamen Implementation in @taxtronik/http-utils.
//
// Strukturelle Konsolidierung: vorher Code-Duplikation Web/Worker (H1/H3/H4-
// Patches mussten zweimal gemacht werden, N1/N2/N9 waren das Symptom).
// Single Source of Truth eliminiert die Drift-Klasse von Findings.
// =============================================================================

export { assertPublicHost, safeFetch, SsrfGuardError } from '@taxtronik/http-utils';
