import { cookies } from 'next/headers';
import { encode } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
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

/** Schreibt ein neues, vollstaendig kontaktgebundenes Portal-Session-JWT. */
export async function writePortalSession(contact: PortalSessionContact): Promise<void> {
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
      sessionIssuedAt: Math.floor(Date.now() / 1000),
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
