// =============================================================================
// Portal-Auth (Mandantenportal) — Magic-Link ohne Auth.js-Provider.
//
// Flow:
//   1. User gibt Email auf /portal/login ein → Server-Action ruft requestMagicLink
//      → Mail mit Token-Link wird verschickt.
//   2. User klickt Link → /portal/login/verify?token=... zeigt nur die
//      Profilauswahl (GET verbraucht den Einmal-Link nicht).
//   3. Der POST der Profilauswahl (confirmMagicLinkAction) verifiziert und
//      verbraucht den Token und stellt die Session über writePortalSession aus
//      (Cookie-Name, Codec und Laufzeit aus der Portal-Session-Fabrik).
//
// S-05: Die Auth.js-Instanz hat keinen Provider mehr. Der frühere Credentials-
// Provider hatte keinen Aufrufer in der Oberfläche, war aber über
// /api/auth/portal/callback/credentials als zweiter Login-Pfad öffentlich
// erreichbar. Auth.js bleibt nur für Abmelden (portalSignOut) und den
// Session-Endpunkt mit denselben Prüfungen wie portalAuth().
// =============================================================================

import { cache } from 'react';
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import { isTokenRevoked } from './revocation';
import { getSessionIssuedAt } from './session-issued-at';
import { portalSessionFactory } from './portal-session';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';

interface PortalTokenPayload {
  contactId: string;
  tenantId: string;
  clientId: string;
  fullName: string;
  email: string;
  sessionOriginContactId?: unknown;
}

function portalOriginContactId(token: PortalTokenPayload): string | null {
  // ACCESS-TENANT-RLS-001: Older cookies may already have changed profile and
  // issue time. Their original mailbox proof cannot be reconstructed safely.
  return typeof token.sessionOriginContactId === 'string' && token.sessionOriginContactId.length > 0
    ? token.sessionOriginContactId
    : null;
}

function normalizePortalEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function isPortalTokenPayload(t: unknown): t is PortalTokenPayload {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o['contactId'] === 'string' &&
    typeof o['tenantId'] === 'string' &&
    typeof o['clientId'] === 'string' &&
    typeof o['fullName'] === 'string' &&
    normalizePortalEmail(o['email']) !== null
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sessionExpires(token: JWT): string {
  const exp = typeof token.exp === 'number' ? token.exp : Math.floor(Date.now() / 1000);
  return new Date(exp * 1000).toISOString();
}

function hasPortalSessionFields(session: Session | null): session is PortalSession {
  const u = session?.user as
    | { contactId?: unknown; clientId?: unknown; tenantId?: unknown; fullName?: unknown }
    | undefined;
  return (
    !!u &&
    typeof u.contactId === 'string' &&
    typeof u.clientId === 'string' &&
    typeof u.tenantId === 'string' &&
    typeof u.fullName === 'string'
  );
}

async function hydratePortalSessionFromToken(session: Session, token: unknown): Promise<Session> {
  if (!isPortalTokenPayload(token)) return session;

  const tokenIat = getSessionIssuedAt(token);
  if (tokenIat === undefined) return session;
  const originContactId = portalOriginContactId(token);
  if (!originContactId) return session;
  for (const contactId of unique([token.contactId, originContactId])) {
    if (await isTokenRevoked('portal', contactId, tokenIat)) return session;
    if (!(await hasCurrentPortalIdentity(token, contactId))) return session;
  }

  session.user.contactId = token.contactId;
  session.user.tenantId = token.tenantId;
  session.user.clientId = token.clientId;
  session.user.fullName = token.fullName;
  session.user.email = normalizePortalEmail(token.email)!;
  session.user.sessionIssuedAt = tokenIat;
  session.user.sessionOriginContactId = originContactId;
  return session;
}

async function hasCurrentPortalIdentity(
  token: PortalTokenPayload,
  contactId: string,
): Promise<boolean> {
  try {
    const c = await prismaOwner.clientContact.findUnique({
      where: { id: contactId },
      select: {
        active: true,
        email: true,
        tenantId: true,
        clientId: true,
        client: { select: { allowActive: true, anonymizedAt: true, mandateEndedAt: true } },
      },
    });
    if (
      !c ||
      !c.active ||
      normalizePortalEmail(c.email) !== normalizePortalEmail(token.email) ||
      c.tenantId !== token.tenantId ||
      (contactId === token.contactId && c.clientId !== token.clientId) ||
      !c.client.allowActive ||
      c.client.anonymizedAt !== null ||
      c.client.mandateEndedAt != null
    ) {
      log.warn(
        { contactId, tokenTenant: token.tenantId },
        'portal-auth: Session ohne gueltigen/aktiven Kontakt oder Mandant gesperrt/anonymisiert - invalidiert (Re-Login erzwungen)',
      );
      return false;
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'portal-auth: Session-Existenzpruefung fehlgeschlagen - invalidiert (Re-Login erzwungen)',
    );
    return false;
  }
  return true;
}

// Narrower Session-Typ fuer das Portal-Surface. Module-Augmentation fuer
// Session.user liegt zentral in src/types/next-auth.d.ts.
export type PortalSession = Session & {
  user: {
    id: string;
    email: string;
    name: string;
    fullName: string;
    tenantId: string;
    contactId: string;
    clientId: string;
    sessionIssuedAt: number;
    sessionOriginContactId: string;
  };
};

const portalConfig: NextAuthConfig = {
  basePath: '/api/auth/portal',
  // Auth.js v5 verlangt trustHost=true. Der vorgeschaltete Proxy pinnt den
  // Host auf den konfigurierten VHost; Production-Config erzwingt das Opt-in.
  trustHost: env.NEXTAUTH_TRUST_HOST ?? true,
  secret: env.AUTH_SECRET,

  // S-05: kein Provider — Portal-Sessions stellt ausschließlich
  // writePortalSession nach bestätigtem Magic-Link aus (portal-session.ts).
  providers: [],

  // Laufzeit, Codec und Cookie aus der Portal-Session-Fabrik; zur (fehlenden)
  // gleitenden Erneuerung siehe session-factory.ts.
  session: portalSessionFactory.authJs.session,
  jwt: portalSessionFactory.authJs.jwt,
  cookies: portalSessionFactory.authJs.cookies,

  callbacks: {
    async jwt({ token, user }) {
      // Ohne Provider meldet Auth.js nie einen Benutzer an; eine Anmeldung an
      // writePortalSession vorbei wird nicht ausgestellt.
      if (user) return null;
      // ACCESS-TENANT-RLS-001: Reject before Auth.js issues another cookie.
      // Preserve the original time even if revocation races with this refresh.
      const issuedAt = getSessionIssuedAt(token);
      if (issuedAt === undefined || !portalSessionFactory.isLive(token)) return null;
      const session = await hydratePortalSessionFromToken(
        { user: {}, expires: sessionExpires(token) } as Session,
        token,
      );
      if (!hasPortalSessionFields(session)) return null;
      return {
        ...token,
        sessionIssuedAt: issuedAt,
        sessionOriginContactId: session.user.sessionOriginContactId,
      };
    },
    async session({ session, token }) {
      return hydratePortalSessionFromToken(session, token);
    },
  },

  pages: {
    signIn: '/portal/login',
  },
};

const _portal = NextAuth(portalConfig);

// Explizite typeof-Annotationen: ohne sie versucht TypeScript, die Typen
// rückwärts aus @auth/core zu inferieren und landet bei einem Pfad
// `.pnpm/@auth+core@.../...`, den der declaration-emitter als „nicht
// portabel" ablehnt (TS4023 in pnpm-Workspaces). `typeof _portal.signOut`
// schaltet die Inferenz ab — der Typ bleibt funktional identisch.
export const portalHandlers: typeof _portal.handlers = _portal.handlers;
export const portalSignOut: typeof _portal.signOut = _portal.signOut;

/** Verifizierter JWT-Subject ohne DB-Hydration, insbesondere für Logout. */
export async function portalSessionSubject(): Promise<string | null> {
  const token = await portalSessionFactory.read();
  return isPortalTokenPayload(token) ? portalOriginContactId(token) : null;
}

// Härtet die Wrapper-Semantik (analog staffAuth): wenn der session-Callback
// wegen Revocation die contactId nicht gesetzt hat, returnt der Wrapper null.
// React cache(): request-scoped Dedup (analog staffAuth) — Portal-Layout + Pages
// rufen portalAuth mehrfach pro Request; cache() spart die redundanten
// Redis-/DB-Round-Trips ohne Cross-Request-Risiko.
// Symmetrisch zu staffAuth: Cookie und JWT über die Portal-Session-Fabrik
// lesen, danach dieselben Revocation- und DB-Gates wie im Session-Callback.
export const portalAuth = cache(async (): Promise<PortalSession | null> => {
  const token = await portalSessionFactory.read();
  if (!token) return null;

  const baseSession: Session = {
    user: {
      id: typeof token.sub === 'string' ? token.sub : (token.contactId ?? ''),
      email: typeof token.email === 'string' ? token.email : '',
      name: typeof token.name === 'string' ? token.name : (token.fullName ?? ''),
      fullName: '',
      tenantId: '',
    },
    expires: sessionExpires(token),
  };

  const session = await hydratePortalSessionFromToken(baseSession, token);
  return hasPortalSessionFields(session) ? session : null;
});
