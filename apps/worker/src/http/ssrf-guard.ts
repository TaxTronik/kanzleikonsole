// =============================================================================
// Re-Export der gemeinsamen Implementation in @taxtronik/http-utils.
// Vorher Code-Duplikation zur Web-Variante — jetzt Single Source of Truth.
// =============================================================================

export { assertPublicHost, safeFetch, SsrfGuardError } from '@taxtronik/http-utils';
