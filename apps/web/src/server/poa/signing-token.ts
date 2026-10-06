// =============================================================================
// Signatur-Token der Vollmachten: Hashing, Gültigkeit und Ausgabe.
//
// Fachkatalog: POA-SIGNING-CONFIRMATION-001
//
// Gemeinsame Quelle für die Staff-Services (Versand) und den öffentlichen
// Token-Sign-Flow (app/staff/(protected)/poa/sign-actions.ts über
// _signing-shared.ts). Seit K-03 liegt sie unter server/, weil Services nicht
// aus app/ importieren dürfen.
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';

export const SIGNING_TOKEN_TTL_HOURS = 72;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedSigningToken {
  /** Klartext — nur für den Link in der Einladung, nie in der Datenbank. */
  rawToken: string;
  /** SHA-256 (hex) des Klartexts — wird an der Vollmacht gespeichert. */
  tokenHash: string;
  expiresAt: Date;
}

/** Neuer Signatur-Token: Klartext für den Link, Hash und Ablauf für die Datenbank. */
export function issueSigningToken(now: number = Date.now()): IssuedSigningToken {
  const rawToken = randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(now + SIGNING_TOKEN_TTL_HOURS * 60 * 60 * 1000),
  };
}
