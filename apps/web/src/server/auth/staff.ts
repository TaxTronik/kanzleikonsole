import { cache } from 'react';
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import Credentials from 'next-auth/providers/credentials';
import { env } from '@taxtronik/config';
import { isTokenRevoked } from './revocation';
import { getSessionIssuedAt } from './session-issued-at';
import { staffSessionClaims, staffSessionFactory, type StaffSessionUser } from './staff-session';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { getClientIp, checkIpOrGlobalLimit, resetRateLimit } from '@/server/rate-limit';
import { authenticateStaffHardwareCredential } from './webauthn';
import { staffTokenMatchesCurrentAuthState, type StaffAuthMethod } from './staff-auth-state';
import { completeStaffLogin } from './staff-login';
import { restrictAuthJsRoute, type AuthJsRouteSpec } from './authjs-route';

// DEV-/E2E-only: TOTP-Bypass, definiert im Staff-Login-Service (R-04).
export { DEV_SKIP_TOTP } from './staff-login';

// Narrower Session-Typ für das Staff-Surface — Felder, die staff-spezifisch
// sind (staffId, roles), sind hier verpflichtend. Module-Augmentation für
// Session.user liegt zentral in src/types/next-auth.d.ts.
export type StaffSession = Session & {
  user: {
    id: string;
    email: string;
    name: string;
    fullName: string;
    tenantId: string;
    staffId: string;
    roles: string[];
    // iter87: granulare Einzelrechte (StaffPermissionName-Werte). ADMIN/PARTNER
    // brauchen keine — hasStaffPermission (rbac.ts) gibt ihnen implizit alles.
    permissions: string[];
    // Aus dem signierten Token übernehmen, nicht aus dem frischen DB-Snapshot:
    // laufende Actions müssen an genau die authentisierte Revision gebunden
    // bleiben und dürfen eine parallel erhöhte Revision nicht adoptieren.
    authMethod?: StaffAuthMethod;
    authRevision?: number;
  };
};

interface StaffTokenPayload {
  staffId: string;
  tenantId: string;
  fullName: string;
  roles: string[];
  // Optional: Tokens von vor iter87 tragen das Feld nicht — sie bleiben
  // gültig (kein Massen-Logout beim Update); die Session lädt ohnehin frisch.
  permissions?: string[];
  // Legacy-Tokens ohne diese Felder bleiben nur solange gültig, wie das Konto
  // noch authRevision=0 hat und NICHT auf Hardware-only umgestellt wurde.
  authMethod?: StaffAuthMethod;
  authRevision?: number;
}

function isStaffTokenPayload(t: unknown): t is StaffTokenPayload {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o['staffId'] === 'string' &&
    typeof o['tenantId'] === 'string' &&
    typeof o['fullName'] === 'string' &&
    Array.isArray(o['roles']) &&
    o['roles'].every((r) => typeof r === 'string') &&
    (o['permissions'] === undefined ||
      (Array.isArray(o['permissions']) && o['permissions'].every((p) => typeof p === 'string'))) &&
    (o['authMethod'] === undefined ||
      o['authMethod'] === 'totp' ||
      o['authMethod'] === 'backup_code' ||
      o['authMethod'] === 'dev_skip_totp' ||
      o['authMethod'] === 'security_key') &&
    (o['authRevision'] === undefined ||
      (typeof o['authRevision'] === 'number' && Number.isSafeInteger(o['authRevision'])))
  );
}

function sessionExpires(token: JWT): string {
  return staffSessionFactory.expiresAt(token);
}

function hasStaffSessionFields(session: Session | null): session is StaffSession {
  const u = session?.user as
    | {
        staffId?: unknown;
        tenantId?: unknown;
        fullName?: unknown;
        roles?: unknown;
        permissions?: unknown;
      }
    | undefined;
  return (
    !!u &&
    typeof u.staffId === 'string' &&
    typeof u.tenantId === 'string' &&
    typeof u.fullName === 'string' &&
    Array.isArray(u.roles) &&
    Array.isArray(u.permissions)
  );
}

async function hydrateStaffSessionFromToken(session: Session, token: unknown): Promise<Session> {
  if (!isStaffTokenPayload(token)) return session;

  const tokenIat = getSessionIssuedAt(token);
  if (tokenIat === undefined) return session;
  if (await isTokenRevoked('staff', token.staffId, tokenIat)) {
    return session;
  }

  let freshRoles: string[];
  let freshPermissions: string[];
  try {
    const u = await prismaOwner.staffUser.findUnique({
      where: { id: token.staffId },
      select: {
        active: true,
        tenantId: true,
        authRevision: true,
        hardwareOnlyEnabledAt: true,
        roles: { select: { role: true } },
        permissions: { select: { permission: true } },
      },
    });
    if (
      !u ||
      !u.active ||
      u.tenantId !== token.tenantId ||
      !staffTokenMatchesCurrentAuthState(token, u)
    ) {
      log.warn(
        { staffId: token.staffId, tokenTenant: token.tenantId },
        'staff-auth: Session ohne gueltigen User/Tenant - invalidiert (Re-Login erzwungen)',
      );
      return session;
    }
    freshRoles = u.roles.map((r) => r.role as string);
    freshPermissions = u.permissions.map((p) => p.permission as string);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'staff-auth: Session-Existenzpruefung fehlgeschlagen - invalidiert (Re-Login erzwungen)',
    );
    return session;
  }

  session.user.staffId = token.staffId;
  session.user.tenantId = token.tenantId;
  session.user.fullName = token.fullName;
  session.user.roles = freshRoles;
  session.user.permissions = freshPermissions;
  session.user.authMethod = token.authMethod;
  session.user.authRevision = token.authRevision;
  return session;
}

function requestIp(request: Request | undefined): string | null {
  try {
    return request?.headers ? getClientIp(request.headers) : null;
  } catch {
    return null;
  }
}

const STAFF_AUTH_BASE_PATH = '/api/auth/staff';

// B5 (S-05): Über HTTP bleiben nur CSRF-Token, Abmelden und die Callbacks der
// beiden Credentials-Provider erreichbar; session, signin, providers, error und
// alle übrigen Auth.js-Aktionen antworten 404 (authjs-route.ts).
export const STAFF_AUTHJS_ROUTE: AuthJsRouteSpec = {
  basePath: STAFF_AUTH_BASE_PATH,
  endpoints: [
    { method: 'GET', action: 'csrf' },
    { method: 'POST', action: 'signout' },
    { method: 'POST', action: 'callback', providerId: 'credentials' },
    { method: 'POST', action: 'callback', providerId: 'hardware-key' },
  ],
};

const staffConfig: NextAuthConfig = {
  basePath: STAFF_AUTH_BASE_PATH,
  // Auth.js v5 verlangt trustHost=true. Der vorgeschaltete Proxy pinnt den
  // Host auf den konfigurierten VHost; Production-Config erzwingt das Opt-in.
  trustHost: env.NEXTAUTH_TRUST_HOST ?? true,
  secret: env.AUTH_SECRET,

  providers: [
    Credentials({
      // R-04: Schritt 2 der Passwort-/TOTP-Anmeldung. Das Passwort hat
      // checkPasswordAction bereits genau einmal geprüft; hier wird nur das
      // daraus ausgestellte Einmal-Ticket eingelöst (Staff-Login-Service).
      credentials: {
        loginTicket: { label: 'Anmeldeticket', type: 'text' },
        totpCode: { label: 'TOTP-Code', type: 'text' },
      },
      async authorize(credentials, request) {
        const totpCode = credentials?.totpCode;
        return completeStaffLogin({
          loginTicket: credentials?.loginTicket,
          totpCode: typeof totpCode === 'string' ? totpCode : '',
          ip: requestIp(request),
        });
      },
    }),
    Credentials({
      id: 'hardware-key',
      name: 'Physischer Sicherheitsschlüssel',
      credentials: {
        ceremonyId: { label: 'Zeremonie', type: 'text' },
        responseJson: { label: 'WebAuthn-Antwort', type: 'text' },
      },
      async authorize(credentials, request) {
        const ceremonyId = credentials?.ceremonyId as string | undefined;
        const responseJson = credentials?.responseJson as string | undefined;
        if (!ceremonyId || !responseJson) return null;
        const ip = requestIp(request);
        // WebAuthn-Assertions sind nicht erratbar; das Limit schützt nur
        // Lookups. Ohne IP gilt allein die Sturm-Obergrenze (S-03) — ein
        // Bucket je Credential-ID ließe Fremde gezielt sperren.
        const rate = await checkIpOrGlobalLimit('staff-hardware-login', ip, {
          max: 10,
          windowSec: 300,
        });
        if (!rate.ok) return null;
        try {
          const user = await authenticateStaffHardwareCredential({ ceremonyId, responseJson, ip });
          if (user && ip) await resetRateLimit(`staff-hardware-login:${ip}`);
          return user;
        } catch (error) {
          log.warn(
            { component: 'staff-webauthn', name: (error as Error).name },
            'Hardware-Login abgewiesen',
          );
          return null;
        }
      },
    }),
  ],

  // W-1: Session-Laufzeit absolut 24 h ab Anmeldung (Auth.js-Default wären
  // 30 Tage) — Laufzeit, JWT-Codec (begrenzt jede Erneuerung auf Anmeldung +
  // 24 h) und Cookie (__Host-/__Secure-Name, Optionen passend zur Präfix-Wahl)
  // kommen aus der Staff-Session-Fabrik, die auch staffAuth(), Logout und den
  // lokalen Formularpfad bedient. Ein `updateAge` gibt es nicht: Auth.js wertet
  // es für JWT-Sessions nicht aus; Laufzeit und Erneuerung beschreibt
  // session-factory.ts.
  session: staffSessionFactory.authJs.session,
  jwt: staffSessionFactory.authJs.jwt,
  cookies: staffSessionFactory.authJs.cookies,

  callbacks: {
    async jwt({ token, user }) {
      // Neue Anmeldung: dieselben Claims wie bei direkter Ausstellung.
      if (user) return { ...token, ...staffSessionClaims(user as StaffSessionUser) };
      // ACCESS-TENANT-RLS-001: Reject before Auth.js issues another cookie.
      // Preserve the original time even if revocation races with this refresh.
      const issuedAt = getSessionIssuedAt(token);
      if (issuedAt === undefined || !staffSessionFactory.isLive(token)) return null;
      const session = await hydrateStaffSessionFromToken(
        { user: {}, expires: sessionExpires(token) } as Session,
        token,
      );
      if (!hasStaffSessionFields(session)) return null;
      return { ...token, sessionIssuedAt: issuedAt };
    },
    async session({ session, token }) {
      const hydrated = await hydrateStaffSessionFromToken(session, token);
      // Auth.js meldet sonst „jetzt + 24 h“; maßgeblich ist Anmeldung + 24 h.
      hydrated.expires = sessionExpires(token);
      return hydrated;
    },
  },

  pages: {
    signIn: '/staff/login',
    // Die Auth.js-Fehlerseite ist gesperrt (STAFF_AUTHJS_ROUTE); Fehler der
    // verbleibenden Endpunkte leiten auf die Anmeldung statt auf ein 404.
    error: '/staff/login',
  },
};

const _staff = NextAuth(staffConfig);

// Explizite typeof-Annotationen verhindern den TS-Inferenz-Pfad zu
// .pnpm/@auth+core/... (TS4023 in pnpm-Workspaces). Siehe portal.ts.
export const staffHandlers: typeof _staff.handlers = restrictAuthJsRoute(
  _staff.handlers,
  STAFF_AUTHJS_ROUTE,
);
export const staffSignIn: typeof _staff.signIn = _staff.signIn;
export const staffSignOut: typeof _staff.signOut = _staff.signOut;

/** Verifizierter JWT-Subject ohne DB-Hydration, insbesondere für Logout. */
export async function staffSessionSubject(): Promise<string | null> {
  const token = await staffSessionFactory.read();
  return isStaffTokenPayload(token) ? token.staffId : null;
}

// Harter Server-Gatekeeper fuer Staff-Sessions: Cookie und JWT ueber die
// Staff-Session-Fabrik lesen (in Production nur der konfigurierte
// __Host-/__Secure-Name, stabile Salts) und dann dieselben Revocation-/DB-Gates
// wie der NextAuth-Session-Callback pruefen. React cache() dedupliziert diese
// Redis-/DB-Roundtrips request-scoped, ohne Cross-Request-Staleness.
// CI-Haertung: Der Wrapper decodiert das Cookie selbst mit stabilen Salts, damit
// gueltige lokale HTTP-E2E-Sessions nicht von NextAuths auth()-Pipeline verloren
// gehen, bevor unsere eigenen Gates greifen koennen.
export const staffAuth = cache(async (): Promise<StaffSession | null> => {
  const token = await staffSessionFactory.read();
  if (!token) return null;

  const baseSession: Session = {
    user: {
      id: typeof token.sub === 'string' ? token.sub : (token.staffId ?? ''),
      email: typeof token.email === 'string' ? token.email : '',
      name: typeof token.name === 'string' ? token.name : (token.fullName ?? ''),
      fullName: '',
      tenantId: '',
    },
    expires: sessionExpires(token),
  };

  const session = await hydrateStaffSessionFromToken(baseSession, token);
  return hasStaffSessionFields(session) ? session : null;
});
