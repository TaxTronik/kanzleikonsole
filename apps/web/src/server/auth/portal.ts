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
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { env } from '@taxtronik/config';
import { verifyMagicLink } from './magic-link';
import { isTokenRevoked } from './revocation';
import {
  PORTAL_SESSION_COOKIE,
  PORTAL_SESSION_JWT_DECODE_SALTS,
  PORTAL_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
} from './session-cookie';
import { createStableSessionJwtOptions } from './session-jwt';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';

interface PortalTokenPayload {
  contactId: string;
  tenantId: string;
  clientId: string;
  fullName: string;
}

function isPortalTokenPayload(t: unknown): t is PortalTokenPayload {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o['contactId'] === 'string' &&
    typeof o['tenantId'] === 'string' &&
    typeof o['clientId'] === 'string' &&
    typeof o['fullName'] === 'string'
  );
}

// Narrower Session-Typ für das Portal-Surface. Module-Augmentation für
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
  // S9: in Produktion explizit per env opt-in. Dev: implizit true für Komfort.
  trustHost: env.NEXTAUTH_TRUST_HOST ?? (env.NODE_ENV !== 'production'),
  secret: env.AUTH_SECRET,

  providers: [
    Credentials({
      name: 'magic-link',
      credentials: {
        token: { label: 'Magic-Link-Token', type: 'text' },
      },
      async authorize(credentials) {
        const token = credentials?.token as string | undefined;
        if (!token) return null;

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
      // Transienter DB-Fehler → durchlassen (kein Massen-Logout).
      try {
        const c = await prismaOwner.clientContact.findUnique({
          where: { id: token.contactId },
          select: {
            active: true,
            tenantId: true,
            clientId: true,
            client: { select: { allowActive: true, anonymizedAt: true } },
          },
        });
        if (
          !c ||
          !c.active ||
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
          'portal-auth: Session-Existenzprüfung fehlgeschlagen — durchgelassen',
        );
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

// Härtet die Wrapper-Semantik (analog staffAuth): wenn der session-Callback
// wegen Revocation die contactId nicht gesetzt hat, returnt der Wrapper null.
// React cache(): request-scoped Dedup (analog staffAuth) — Portal-Layout + Pages
// rufen portalAuth mehrfach pro Request; cache() spart die redundanten
// Redis-/DB-Round-Trips ohne Cross-Request-Risiko.
export const portalAuth = cache(async (): Promise<PortalSession | null> => {
  const raw = await _portal.auth();
  if (!raw?.user) return null;
  const u = raw.user as { contactId?: string };
  if (!u.contactId) return null;
  return raw as PortalSession;
});
