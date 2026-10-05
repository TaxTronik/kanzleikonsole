// =============================================================================
// Portal-Session-Fabrik (S-05) — einzige Instanz für das Mandantenportal.
// Portal-Sessions entstehen ausschließlich hier: nach bestätigtem Magic-Link
// (confirmMagicLinkAction) und beim Profilwechsel. Auth.js stellt für das
// Portal keine Session mehr aus (kein Provider). Siehe session-factory.ts.
// =============================================================================

import type { JWT } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import { getSessionIssuedAt } from './session-issued-at';
import {
  PORTAL_SESSION_COOKIE,
  PORTAL_SESSION_COOKIE_BASE,
  PORTAL_SESSION_JWT_DECODE_SALTS,
  PORTAL_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
} from './session-cookie';
import { createSessionFactory } from './session-factory';

export const portalSessionFactory = createSessionFactory({
  cookieName: PORTAL_SESSION_COOKIE,
  cookieBase: PORTAL_SESSION_COOKIE_BASE,
  secure: USE_SECURE_COOKIES,
  domain: env.PORTAL_COOKIE_DOMAIN || undefined,
  jwtSalt: PORTAL_SESSION_JWT_SALT,
  jwtDecodeSalts: PORTAL_SESSION_JWT_DECODE_SALTS,
  secret: env.AUTH_SECRET,
});

export interface PortalSessionContact {
  id: string;
  tenantId: string;
  clientId: string;
  email: string;
  fullName: string;
}

export interface PortalSessionIdentity {
  sessionIssuedAt: number;
  sessionOriginContactId: string;
}

/** Claims eines Portal-JWT; Profilwechsel übernehmen die ursprüngliche Identität. */
export function portalSessionToken(
  contact: PortalSessionContact,
  identity: PortalSessionIdentity,
): JWT {
  return {
    sub: contact.id,
    email: contact.email,
    name: contact.fullName,
    contactId: contact.id,
    tenantId: contact.tenantId,
    clientId: contact.clientId,
    fullName: contact.fullName,
    sessionIssuedAt: identity.sessionIssuedAt,
    sessionOriginContactId: identity.sessionOriginContactId,
  };
}

/** New mailbox authentication starts an identity; profile switches preserve it. */
export async function writePortalSession(
  contact: PortalSessionContact,
  identity: PortalSessionIdentity = {
    sessionIssuedAt: Math.floor(Date.now() / 1000),
    sessionOriginContactId: contact.id,
  },
): Promise<void> {
  if (getSessionIssuedAt(identity) === undefined || !identity.sessionOriginContactId) {
    throw new Error('Invalid original portal session identity');
  }
  await portalSessionFactory.issue(portalSessionToken(contact, identity));
}
