// =============================================================================
// Portal-Auth (Mandantenportal) — Magic-Link via Credentials-Provider.
//
// Flow:
//   1. User gibt Email auf /portal/login ein → Server-Action ruft requestMagicLink
//      → Mail mit Token-Link wird verschickt.
//   2. User klickt Link → /portal/login/verify?token=...
//   3. Verify-Page ruft portalSignIn('credentials', { token, ... }) auf.
//   4. authorize() verifiziert Token via verifyMagicLink, gibt Contact zurück.
//   5. JWT-Session wird gesetzt (Cookie-Name siehe session-cookie.ts, path=/).
// =============================================================================

import { cache } from 'react';
import { cookies } from 'next/headers';
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import { decode, type JWT } from 'next-auth/jwt';
import Credentials from 'next-auth/providers/credentials';
import { env } from '@taxtronik/config';
import { verifyMagicLink } from './magic-link';
import { isTokenRevoked } from './revocation';
import { getClientIp, checkIpOrGlobalLimit } from '@/server/rate-limit';
import {
  PORTAL_SESSION_COOKIE,
  PORTAL_SESSION_COOKIE_BASE,
  PORTAL_SESSION_JWT_DECODE_SALTS,
  PORTAL_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
  readSessionCookieValue,
  sessionCookieNameVariants,
} from './session-cookie';
import { createStableSessionJwtOptions } from './session-jwt';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';

interface PortalTokenPayload {
  contactId: string;
  tenantId: string;
  clientId: string;
  fullName: string;
  email: string;
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

// Harte Server-Session-Validierung fuer portalAuth: Cookie prefix-tolerant
// lesen, JWT mit stabilen Salts decodieren und dann Revocation/DB pruefen.
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function portalSessionCookieNames(): string[] {
  return unique([PORTAL_SESSION_COOKIE, ...sessionCookieNameVariants(PORTAL_SESSION_COOKIE_BASE)]);
}

async function readPortalSessionTokenCookie(): Promise<string | null> {
  const jar = await cookies();
  return readSessionCookieValue(jar, portalSessionCookieNames());
}

function hasValidJwtLifetime(token: JWT): boolean {
  return typeof token.exp === 'number' && token.exp > Math.floor(Date.now() / 1000);
}

async function decodePortalSessionToken(rawToken: string): Promise<JWT | null> {
  for (const salt of unique(PORTAL_SESSION_JWT_DECODE_SALTS)) {
    try {
      const token = await decode({ token: rawToken, secret: env.AUTH_SECRET, salt });
      if (token && hasValidJwtLifetime(token)) return token;
    } catch {
      // Historical salt miss; try the next candidate.
    }
  }
  return null;
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

  const tokenIat = (token as { iat?: number }).iat;
  if (await isTokenRevoked('portal', token.contactId, tokenIat)) {
    return session;
  }

  try {
    const c = await prismaOwner.clientContact.findUnique({
      where: { id: token.contactId },
      select: {
        active: true,
        email: true,
        tenantId: true,
        clientId: true,
        client: { select: { allowActive: true, anonymizedAt: true } },
      },
    });
    if (
      !c ||
      !c.active ||
      normalizePortalEmail(c.email) !== normalizePortalEmail(token.email) ||
      c.tenantId !== token.tenantId ||
      c.clientId !== token.clientId ||
      !c.client.allowActive ||
      c.client.anonymizedAt !== null
    ) {
      log.warn(
        { contactId: token.contactId, tokenTenant: token.tenantId },
        'portal-auth: Session ohne gueltigen/aktiven Kontakt oder Mandant gesperrt/anonymisiert - invalidiert (Re-Login erzwungen)',
      );
      return session;
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'portal-auth: Session-Existenzpruefung fehlgeschlagen - invalidiert (Re-Login erzwungen)',
    );
    return session;
  }

  session.user.contactId = token.contactId;
  session.user.tenantId = token.tenantId;
  session.user.clientId = token.clientId;
  session.user.fullName = token.fullName;
  return session;
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
  };
};

const portalConfig: NextAuthConfig = {
  basePath: '/api/auth/portal',
  // Auth.js v5 verlangt trustHost=true. Der vorgeschaltete Proxy pinnt den
  // Host auf den konfigurierten VHost; Production-Config erzwingt das Opt-in.
  trustHost: env.NEXTAUTH_TRUST_HOST ?? true,
  secret: env.AUTH_SECRET,

  providers: [
    Credentials({
      name: 'magic-link',
      credentials: {
        token: { label: 'Magic-Link-Token', type: 'text' },
      },
      async authorize(credentials, request) {
        const token = credentials?.token as string | undefined;
        if (!token) return null;

        // Pre-Lookup-Rate-Limit (symmetrisch zum Staff-Login): der Token ist zwar
        // 256-bit-Zufall und gehasht (Brute-Force chancenlos), aber ohne Limit
        // kann ein Angreifer unbegrenzt sha256+DB-Lookups gegen den Callback
        // fahren. Per-IP eng, bei fehlender IP globaler Sturm-Bucket.
        const ip = (() => {
          try {
            return request?.headers ? getClientIp(request.headers) : null;
          } catch {
            return null;
          }
        })();
        const rl = await checkIpOrGlobalLimit(
          'portal-authorize',
          ip,
          { max: 10, windowSec: 600 },
          { max: 200, windowSec: 600 },
        );
        if (!rl.ok) {
          log.warn(
            { ip, bucket: ip ? 'per-ip' : 'global' },
            'portal-auth: authorize-rate-limit hit',
          );
          return null;
        }

        const result = await verifyMagicLink(token);
        if (!result) return null;

        const c = result.contact;
        return {
          id: c.id,
          email: c.email,
          name: c.fullName,
          contactId: c.id,
          tenantId: c.tenantId,
          clientId: c.clientId,
          fullName: c.fullName,
        };
      },
    }),
  ],

  // W-1: explizite Session-TTL — symmetrisch zu staff.ts. Default wäre 30 Tage;
  // Doku/Revocation-Logik geht von 24 h aus, also pinnen wir das hier hart.
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60,
    updateAge: 4 * 60 * 60,
  },

  jwt: createStableSessionJwtOptions(PORTAL_SESSION_JWT_SALT, PORTAL_SESSION_JWT_DECODE_SALTS),

  cookies: {
    sessionToken: {
      // Härtung: __Host-/__Secure-Präfix in Production — Name zentral in
      // session-cookie.ts (Begründung + Constraints dort, analog staff.ts).
      name: PORTAL_SESSION_COOKIE,
      options: {
        httpOnly: true,
        secure: USE_SECURE_COOKIES,
        sameSite: 'lax' as const,
        path: '/',
        ...(env.PORTAL_COOKIE_DOMAIN ? { domain: env.PORTAL_COOKIE_DOMAIN } : {}),
      },
    },
  },

  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const u = user as PortalTokenPayload;
        token.contactId = u.contactId;
        token.tenantId = u.tenantId;
        token.clientId = u.clientId;
        token.fullName = u.fullName;
        token.email = normalizePortalEmail(u.email) ?? '';
      }
      return token;
    },
    async session({ session, token }) {
      // Runtime-Check (Q9) — siehe Begründung in staff.ts
      if (!isPortalTokenPayload(token)) return session;

      // S11: Revocation-Check.
      const tokenIat = (token as { iat?: number }).iat;
      if (await isTokenRevoked('portal', token.contactId, tokenIat)) {
        return session;
      }

      // Härtung (analog staff.ts): die Session MUSS zu einem existierenden,
      // AKTIVEN Kontakt gehören, dessen Tenant + Mandant mit dem Token
      // übereinstimmen. Der Login (verifyMagicLink) prüft `active: true` —
      // ohne laufende Revalidierung könnte ein deaktivierter Kontakt bis zum
      // JWT-Ablauf (24 h) bzw. bis zur Revocation weiterarbeiten. prismaOwner
      // (BYPASSRLS) ist nötig, weil der Callback außerhalb eines Tenant-Kontexts
      // läuft; die Tenant/Mandant-Gleichheit wird gegen das Token erzwungen.
      // GwG-Schranke (§ 11 GwG): zusätzlich MUSS der Parent-Mandant aktiv
      // (allowActive) und nicht anonymisiert sein — bei GwG-Ablauf/-Ablehnung
      // wird allowActive=false gesetzt, das Portal ist dann gesperrt. Läuft im
      // selben Lookup mit (kein zusätzlicher Round-Trip).
      // Fail-closed: bei unbestätigtem DB-Stand keine alte Portal-Session
      // weiterreichen.
      try {
        const c = await prismaOwner.clientContact.findUnique({
          where: { id: token.contactId },
          select: {
            active: true,
            email: true,
            tenantId: true,
            clientId: true,
            client: { select: { allowActive: true, anonymizedAt: true } },
          },
        });
        if (
          !c ||
          !c.active ||
          normalizePortalEmail(c.email) !== normalizePortalEmail(token.email) ||
          c.tenantId !== token.tenantId ||
          c.clientId !== token.clientId ||
          !c.client.allowActive ||
          c.client.anonymizedAt !== null
        ) {
          log.warn(
            { contactId: token.contactId, tokenTenant: token.tenantId },
            'portal-auth: Session ohne gültigen/aktiven Kontakt oder Mandant gesperrt/anonymisiert — invalidiert (Re-Login erzwungen)',
          );
          return session; // keine Portal-Felder → portalAuth liefert null
        }
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          'portal-auth: Session-Existenzprüfung fehlgeschlagen — invalidiert (Re-Login erzwungen)',
        );
        return session; // keine Portal-Felder → portalAuth liefert null
      }

      session.user.contactId = token.contactId;
      session.user.tenantId = token.tenantId;
      session.user.clientId = token.clientId;
      session.user.fullName = token.fullName;
      return session;
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
// portabel" ablehnt (TS4023 in pnpm-Workspaces). `typeof _portal.signIn`
// schaltet die Inferenz ab — der Typ bleibt funktional identisch.
export const portalHandlers: typeof _portal.handlers = _portal.handlers;
export const portalSignIn: typeof _portal.signIn = _portal.signIn;
export const portalSignOut: typeof _portal.signOut = _portal.signOut;

/** Verifizierter JWT-Subject ohne DB-Hydration, insbesondere für Logout. */
export async function portalSessionSubject(): Promise<string | null> {
  const rawToken = await readPortalSessionTokenCookie();
  if (!rawToken) return null;
  const token = await decodePortalSessionToken(rawToken);
  return isPortalTokenPayload(token) ? token.contactId : null;
}

// Härtet die Wrapper-Semantik (analog staffAuth): wenn der session-Callback
// wegen Revocation die contactId nicht gesetzt hat, returnt der Wrapper null.
// React cache(): request-scoped Dedup (analog staffAuth) — Portal-Layout + Pages
// rufen portalAuth mehrfach pro Request; cache() spart die redundanten
// Redis-/DB-Round-Trips ohne Cross-Request-Risiko.
// Symmetrisch zu staffAuth: direkte Cookie/JWT-Validierung, danach dieselben
// Revocation- und DB-Gates wie im NextAuth-Session-Callback.
export const portalAuth = cache(async (): Promise<PortalSession | null> => {
  const rawToken = await readPortalSessionTokenCookie();
  if (!rawToken) return null;

  const token = await decodePortalSessionToken(rawToken);
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
