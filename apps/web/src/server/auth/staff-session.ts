// =============================================================================
// Staff-Session-Fabrik (S-05) — einzige Instanz für das Staff-Surface. Siehe
// session-factory.ts für Lesen, Ausstellen, Löschen sowie Laufzeit/Erneuerung.
// =============================================================================

import type { JWT } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import {
  STAFF_SESSION_COOKIE,
  STAFF_SESSION_COOKIE_BASE,
  STAFF_SESSION_JWT_DECODE_SALTS,
  STAFF_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
} from './session-cookie';
import { createSessionFactory } from './session-factory';
import type { StaffAuthMethod } from './staff-auth-state';

export const staffSessionFactory = createSessionFactory({
  cookieName: STAFF_SESSION_COOKIE,
  cookieBase: STAFF_SESSION_COOKIE_BASE,
  secure: USE_SECURE_COOKIES,
  domain: env.STAFF_COOKIE_DOMAIN || undefined,
  jwtSalt: STAFF_SESSION_JWT_SALT,
  jwtDecodeSalts: STAFF_SESSION_JWT_DECODE_SALTS,
  secret: env.AUTH_SECRET,
});

/** Ergebnis eines erfolgreichen Staff-Logins (Auth.js-`authorize` oder lokaler Formularpfad). */
export interface StaffSessionUser {
  id: string;
  email: string;
  name: string;
  staffId: string;
  tenantId: string;
  fullName: string;
  roles: string[];
  // Tokens von vor iter87 trugen keine Einzelrechte; neue Logins immer.
  permissions?: string[];
  authMethod?: StaffAuthMethod;
  authRevision?: number;
}

/**
 * Staff-spezifische Claims eines neuen JWT. `sessionIssuedAt` ist der
 * ursprüngliche Anmeldezeitpunkt, gegen den Widerrufe geprüft werden
 * (ACCESS-TENANT-RLS-001); spätere Erneuerungen behalten ihn bei.
 */
export function staffSessionClaims(user: StaffSessionUser): JWT {
  return {
    staffId: user.staffId,
    tenantId: user.tenantId,
    fullName: user.fullName,
    roles: user.roles,
    permissions: user.permissions ?? [],
    authMethod: user.authMethod,
    authRevision: user.authRevision,
    sessionIssuedAt: Math.floor(Date.now() / 1000),
  };
}

/** Vollständiges JWT für eine direkte Ausstellung — dieselben Claims wie über Auth.js. */
export function staffSessionToken(user: StaffSessionUser): JWT {
  return { sub: user.id, email: user.email, name: user.name, ...staffSessionClaims(user) };
}
