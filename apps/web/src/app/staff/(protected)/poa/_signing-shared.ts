// =============================================================================
// Geteilt zwischen Staff-Actions (Vollmacht erstellen/senden/widerrufen) und
// dem oeffentlichen Token-Sign-Flow (sign-actions.ts): Token-Hashing + TTL.
// Bewusst OHNE 'use server'.
// =============================================================================

import { createHash } from 'node:crypto';

export const SIGNING_TOKEN_TTL_HOURS = 72;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
