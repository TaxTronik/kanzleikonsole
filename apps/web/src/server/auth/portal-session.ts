import { cookies } from 'next/headers';
import { encode } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import { getSessionIssuedAt } from './session-issued-at';
import {
  PORTAL_SESSION_COOKIE,
  PORTAL_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
} from './session-cookie';

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
  const sessionToken = await encode({
    secret: env.AUTH_SECRET,
    salt: PORTAL_SESSION_JWT_SALT,
    maxAge: 24 * 60 * 60,
    token: {
      sub: contact.id,
      email: contact.email,
      name: contact.fullName,
      contactId: contact.id,
      tenantId: contact.tenantId,
      clientId: contact.clientId,
      fullName: contact.fullName,
      sessionIssuedAt: identity.sessionIssuedAt,
      sessionOriginContactId: identity.sessionOriginContactId,
    },
  });

  const jar = await cookies();
  jar.set(PORTAL_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: USE_SECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60,
    ...(env.PORTAL_COOKIE_DOMAIN ? { domain: env.PORTAL_COOKIE_DOMAIN } : {}),
  });
}
