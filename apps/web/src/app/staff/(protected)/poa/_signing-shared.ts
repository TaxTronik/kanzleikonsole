// =============================================================================
// Geteilt zwischen Staff-Actions (Vollmacht erstellen/senden/widerrufen) und
// dem oeffentlichen Token-Sign-Flow (sign-actions.ts): Token-Hashing + TTL.
// Bewusst OHNE 'use server'. Quelle seit K-03: server/poa/signing-token.ts
// (die Staff-Services unter server/poa duerfen nicht aus app/ importieren).
// =============================================================================

export { SIGNING_TOKEN_TTL_HOURS, hashToken } from '@/server/poa/signing-token';
