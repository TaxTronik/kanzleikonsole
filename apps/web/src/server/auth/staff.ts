import { cache } from 'react';
import { cookies } from 'next/headers';
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import { decode, type JWT } from 'next-auth/jwt';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { env } from '@taxtronik/config';
import { decryptTotpSecret, verifyTotpCode } from './totp';
import { resetFailedLogin } from './lockout';
import { recordFailedLoginAudited, auditIp } from './login-audit';
import { isTokenRevoked } from './revocation';
import { getSessionIssuedAt } from './session-issued-at';
import {
  STAFF_SESSION_COOKIE,
  STAFF_SESSION_COOKIE_BASE,
  STAFF_SESSION_JWT_DECODE_SALTS,
  STAFF_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
  readSessionCookieValue,
  sessionCookieNameVariants,
} from './session-cookie';
import { createStableSessionJwtOptions } from './session-jwt';
import { evidenceService } from '@/server/container';
import { consumeTotpCode } from './totp-replay';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import {
  getClientIp,
  checkIpOrGlobalLimit,
  checkStaffPasswordAccountLimit,
  resetRateLimit,
  staffPasswordAccountRateLimitKey,
} from '@/server/rate-limit';
import { authenticateStaffHardwareCredential } from './webauthn';
import { staffTokenMatchesCurrentAuthState, type StaffAuthMethod } from './staff-auth-state';

// DEV-/E2E-only: TOTP-Bypass fuer lokale Entwicklung und den lokalen CI-E2E-
// Lauf. In echter Produktion bleibt der Bypass aus; der CI-Sonderfall braucht
// zusaetzlich CI=true, E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION=true und einen
// localhost-NEXTAUTH_URL.
function isLocalhostAuthUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

const ALLOW_CI_PRODUCTION_TOTP_SKIP =
  env.NODE_ENV === 'production' &&
  process.env['CI'] === 'true' &&
  process.env['E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION'] === 'true' &&
  isLocalhostAuthUrl(env.NEXTAUTH_URL);

export const DEV_SKIP_TOTP =
  process.env['DEV_SKIP_TOTP'] === 'true' &&
  (env.NODE_ENV !== 'production' || ALLOW_CI_PRODUCTION_TOTP_SKIP);

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

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function staffSessionCookieNames(): string[] {
  return unique([STAFF_SESSION_COOKIE, ...sessionCookieNameVariants(STAFF_SESSION_COOKIE_BASE)]);
}

async function readStaffSessionTokenCookie(): Promise<string | null> {
  const jar = await cookies();
  return readSessionCookieValue(jar, staffSessionCookieNames());
}

function hasValidJwtLifetime(token: JWT): boolean {
  return typeof token.exp === 'number' && token.exp > Math.floor(Date.now() / 1000);
}

async function decodeStaffSessionToken(rawToken: string): Promise<JWT | null> {
  for (const salt of unique(STAFF_SESSION_JWT_DECODE_SALTS)) {
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

function passwordAuthenticationBlocked(account: {
  hardwareOnlyEnabledAt: Date | null;
  lockedUntil: Date | null;
}): boolean {
  return (
    Boolean(account.hardwareOnlyEnabledAt) ||
    Boolean(account.lockedUntil && account.lockedUntil > new Date())
  );
}

const staffConfig: NextAuthConfig = {
  basePath: '/api/auth/staff',
  // Auth.js v5 verlangt trustHost=true. Der vorgeschaltete Proxy pinnt den
  // Host auf den konfigurierten VHost; Production-Config erzwingt das Opt-in.
  trustHost: env.NEXTAUTH_TRUST_HOST ?? true,
  secret: env.AUTH_SECRET,

  providers: [
    Credentials({
      credentials: {
        email: { label: 'E-Mail', type: 'email' },
        password: { label: 'Passwort', type: 'password' },
        totpCode: { label: 'TOTP-Code', type: 'text' },
        tenantSlug: { label: 'Kanzlei', type: 'text' },
      },
      async authorize(credentials, request) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const totpCode = (credentials?.totpCode as string | undefined) ?? '';
        const tenantSlug = (credentials?.tenantSlug as string | undefined) ?? 'default';

        // L-4: IP für IP-basierten Distinct-Lockout extrahieren. Wenn die
        // Request-Headers fehlen (z. B. Test-Pfad), bleibt es null und der
        // Lockout fällt automatisch auf den count-basierten Fallback zurück.
        const ip = (() => {
          try {
            return request?.headers ? getClientIp(request.headers) : null;
          } catch {
            return null;
          }
        })();

        if (!email || !password) return null;

        // K1+N3: Pre-bcrypt-IP-Rate-Limit am NextAuth-callback. Per-IP eng,
        // bei null-IP weiter globaler Sturm-Bucket (kein Per-Account-DoS).
        // Hintergrund siehe docs/compliance/tenancy-model.md.
        const rl = await checkIpOrGlobalLimit(
          'staff-authorize',
          ip,
          { max: 10, windowSec: 600 },
          { max: 200, windowSec: 600 },
        );
        if (!rl.ok) {
          log.warn(
            { ip, bucket: ip ? 'per-ip' : 'global' },
            'staff-auth: authorize-rate-limit hit',
          );
          return null;
        }

        // Tenant via Owner-Verbindung laden (kein RLS-Kontext nötig)
        const tenant = await prismaOwner.tenant.findFirst({
          where: { slug: tenantSlug },
        });
        if (!tenant) return null;

        // Mitarbeiter laden
        const staffUser = await prismaOwner.staffUser.findFirst({
          where: { tenantId: tenant.id, email },
          include: { roles: true, permissions: true },
        });
        if (!staffUser || !staffUser.active) return null;

        // Hardware-only ist eine serverseitige Kontoeigenschaft. Weder das
        // Passwort noch DEV_SKIP_TOTP dürfen als versteckter Fallback dienen.
        if (passwordAuthenticationBlocked(staffUser)) return null;

        // Passwort prüfen
        const accountRl = await checkStaffPasswordAccountLimit(staffUser.id);
        if (!accountRl.ok) {
          log.warn({ staffId: staffUser.id }, 'staff-auth: account password-rate-limit hit');
          return null;
        }

        const passwordOk = await compare(password, staffUser.passwordHash);
        if (!passwordOk) {
          // Account-gebundener Lockout (S2): IP-RL allein hilft nicht gegen
          // verteilte Brute-Force. Fehler werden geloggt, nicht geschluckt.
          // RF-12: zählt UND schreibt auth.login.failure(/.lockout) in die Chain.
          await recordFailedLoginAudited({
            tenantId: tenant.id,
            staffUserId: staffUser.id,
            email: staffUser.email,
            ip,
            reason: 'password',
          });
          return null;
        }

        // DEV-ONLY: TOTP komplett überspringen (Login nur mit Passwort).
        // Doppelt gegated über DEV_SKIP_TOTP — in Produktion nie aktiv.
        if (DEV_SKIP_TOTP) {
          log.warn(
            { staffId: staffUser.id },
            'staff-auth: DEV_SKIP_TOTP aktiv — TOTP übersprungen (NUR Dev!)',
          );
          await resetRateLimit(ip ? `staff-authorize:${ip}` : 'staff-authorize:global');
          await resetRateLimit(staffPasswordAccountRateLimitKey(staffUser.id));
          await resetFailedLogin(prismaOwner, staffUser.id);
          // RF-12: auch der Dev-Login landet in der Chain (method markiert ihn).
          await prismaOwner.$transaction((tx) =>
            evidenceService.record(tx, {
              tenantId: tenant.id,
              actorType: 'STAFF',
              actorId: staffUser.id,
              action: 'auth.login.success',
              resourceType: 'staff_user',
              resourceId: staffUser.id,
              after: { email: staffUser.email, method: 'dev_skip_totp' },
              ip: auditIp(ip),
            }),
          );
          return {
            id: staffUser.id,
            email: staffUser.email,
            name: staffUser.fullName,
            staffId: staffUser.id,
            tenantId: tenant.id,
            fullName: staffUser.fullName,
            roles: staffUser.roles.map((r) => r.role as string),
            permissions: staffUser.permissions.map((p) => p.permission as string),
            authMethod: 'dev_skip_totp' as const,
            authRevision: staffUser.authRevision,
          };
        }

        // TOTP ist Pflicht — ohne Enrollment kein Login
        await resetRateLimit(staffPasswordAccountRateLimitKey(staffUser.id));
        if (!staffUser.totpSecretEnc || !staffUser.totpEnrolledAt) return null;

        // TOTP-Code prüfen
        if (!totpCode) return null;
        const secret = decryptTotpSecret(staffUser.totpSecretEnc, tenant.id, env.AUTH_SECRET);
        const totpValid = verifyTotpCode(totpCode, secret);

        // V-1: Backup-Code-Recovery. Wenn TOTP nicht matched, prüfen wir gegen
        // die hashedTotpBackupCodes (8 one-time-use codes aus dem Enrollment).
        // bcrypt-compare ist teuer (12 rounds × 8 codes = ~1s im Worst Case),
        // aber das ist der Recovery-Pfad — Latenz ist hier akzeptabel.
        // totpBackupCodes ist im Schema Json? — wir holen die String-Liste raus.
        const backupCodes: string[] = Array.isArray(staffUser.totpBackupCodes)
          ? (staffUser.totpBackupCodes as unknown[]).filter(
              (x): x is string => typeof x === 'string',
            )
          : [];
        let usedBackupIndex = -1;
        if (!totpValid && backupCodes.length > 0) {
          for (let i = 0; i < backupCodes.length; i++) {
            const hashed = backupCodes[i]!;
            if (await compare(totpCode, hashed)) {
              usedBackupIndex = i;
              break;
            }
          }
        }

        if (!totpValid && usedBackupIndex < 0) {
          await recordFailedLoginAudited({
            tenantId: tenant.id,
            staffUserId: staffUser.id,
            email: staffUser.email,
            ip,
            reason: 'totp',
          });
          return null;
        }

        if (totpValid) {
          // H5: Replay-Schutz. Auch wenn der Code mathematisch gültig ist, darf
          // er pro (staffId, code) nur einmal akzeptiert werden. Fail-closed bei
          // Redis-Ausfall (kein Redis → kein TOTP-Login).
          const fresh = await consumeTotpCode(staffUser.id, totpCode);
          if (fresh === null) {
            log.warn(
              { staffId: staffUser.id },
              'staff-auth: TOTP-Replay-Store nicht erreichbar — Login abgewiesen',
            );
            return null;
          }
          if (!fresh) {
            await recordFailedLoginAudited({
              tenantId: tenant.id,
              staffUserId: staffUser.id,
              email: staffUser.email,
              ip,
              reason: 'totp_replay',
            });
            return null;
          }
        } else {
          // V-1/W-3: Backup-Code one-time-use atomar konsumieren. Vorher:
          //   filter() + fireAndForget()
          // hatte zwei Probleme:
          //  - fire-and-forget: schlägt das Update transient fehl, bleibt der
          //    benutzte Code im Array und kann ein zweites Mal akzeptiert
          //    werden — one-time-Garantie weg.
          //  - Read-Modify-Write race: zwei parallele Logins mit Codes A und B
          //    lesen denselben Initial-Array, schreiben jeweils ihren
          //    gefilterten Array zurück — letzter Writer gewinnt, einer der
          //    Codes „kommt zurück".
          // Fix: SELECT FOR UPDATE + Re-Check innerhalb $transaction, dann
          // UPDATE. await — keine Background-Promise.
          const usedHash = backupCodes[usedBackupIndex]!;
          const consumed = await prismaOwner.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<{ totp_backup_codes: unknown }[]>`
              SELECT totp_backup_codes FROM staff_user
              WHERE id = ${staffUser.id}::uuid
              FOR UPDATE
            `;
            const current: string[] = Array.isArray(rows[0]?.totp_backup_codes)
              ? (rows[0]!.totp_backup_codes as unknown[]).filter(
                  (x): x is string => typeof x === 'string',
                )
              : [];
            const idx = current.indexOf(usedHash);
            if (idx < 0) {
              // Anderer Login hat denselben Code zwischenzeitlich konsumiert.
              return false;
            }
            const remaining = current.filter((_, i) => i !== idx);
            await tx.staffUser.update({
              where: { id: staffUser.id },
              data: { totpBackupCodes: remaining },
            });
            // RF-12: One-Time-Verbrauch eines Backup-Codes ist sicherheits-
            // relevant (umgeht TOTP) → in DERSELBEN Tx in die Audit-Chain.
            await evidenceService.record(tx, {
              tenantId: tenant.id,
              actorType: 'STAFF',
              actorId: staffUser.id,
              action: 'auth.backup_code.consume',
              resourceType: 'staff_user',
              resourceId: staffUser.id,
              after: { email: staffUser.email, remainingBackupCodes: remaining.length },
              ip: auditIp(ip),
            });
            return remaining.length;
          });
          if (consumed === false) {
            log.warn(
              { staffId: staffUser.id },
              'staff-auth: TOTP-Backup-Code Race verloren — Login abgewiesen',
            );
            await recordFailedLoginAudited({
              tenantId: tenant.id,
              staffUserId: staffUser.id,
              email: staffUser.email,
              ip,
              reason: 'backup_code_race',
            });
            return null;
          }
          log.warn(
            { staffId: staffUser.id, remainingBackupCodes: consumed },
            'staff-auth: TOTP-Backup-Code verwendet (Recovery-Pfad)',
          );
        }

        // Erfolg → Counter vollständig zurücksetzen, bevor der Login als
        // erfolgreich zurückgegeben wird. Sonst kann ein noch laufender
        // Fehlversuch-Write den erfolgreichen Reset zeitlich überholen.
        // RF-12: der Login-Erfolg gehört in die Audit-Hash-Chain
        // (auth.login.success) — in DERSELBEN Tx wie der lastLoginAt-Write
        // (Record-Muster wie überall) und deshalb awaited statt fire-and-forget.
        await resetFailedLogin(prismaOwner, staffUser.id);
        await resetRateLimit(ip ? `staff-authorize:${ip}` : 'staff-authorize:global');
        await prismaOwner.$transaction(async (tx) => {
          await tx.staffUser.update({
            where: { id: staffUser.id },
            data: { lastLoginAt: new Date() },
          });
          await evidenceService.record(tx, {
            tenantId: tenant.id,
            actorType: 'STAFF',
            actorId: staffUser.id,
            action: 'auth.login.success',
            resourceType: 'staff_user',
            resourceId: staffUser.id,
            after: { email: staffUser.email, method: totpValid ? 'totp' : 'backup_code' },
            ip: auditIp(ip),
          });
        });

        return {
          id: staffUser.id,
          email: staffUser.email,
          name: staffUser.fullName,
          staffId: staffUser.id,
          tenantId: tenant.id,
          fullName: staffUser.fullName,
          roles: staffUser.roles.map((r) => r.role as string),
          // iter87: Einzelrechte MÜSSEN auch im Produktions-Login ins Token,
          // damit alte und neue JWT-Schemata sauber unterschieden werden.
          permissions: staffUser.permissions.map((p) => p.permission as string),
          authMethod: (totpValid ? 'totp' : 'backup_code') as StaffAuthMethod,
          authRevision: staffUser.authRevision,
        };
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
        const ip = (() => {
          try {
            return request?.headers ? getClientIp(request.headers) : null;
          } catch {
            return null;
          }
        })();
        const rateKey = ip ? `staff-hardware-login:${ip}` : 'staff-hardware-login:global';
        const rate = await checkIpOrGlobalLimit(
          'staff-hardware-login',
          ip,
          { max: 10, windowSec: 300 },
          { max: 200, windowSec: 300 },
        );
        if (!rate.ok) return null;
        try {
          const user = await authenticateStaffHardwareCredential({ ceremonyId, responseJson, ip });
          if (user) await resetRateLimit(rateKey);
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

  // W-1: explizite Session-TTL. Auth.js-Default ist 30 Tage — die Doku
  // (revocation.ts, S11) geht aber von 24 h aus. Ohne maxAge wäre der
  // Revocation-Worst-Case 30 Tage statt einem Tag, was die Compliance-
  // Aussage „Logout = Sessions sofort invalidiert (max. 24h-Restzeit)"
  // bricht. updateAge: jedes Mal, wenn das Token innerhalb von 4 h vor
  // seinem Ablauf benutzt wird, wird es serverseitig erneuert.
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60,
    updateAge: 4 * 60 * 60,
  },

  jwt: createStableSessionJwtOptions(STAFF_SESSION_JWT_SALT, STAFF_SESSION_JWT_DECODE_SALTS),

  cookies: {
    sessionToken: {
      // Härtung: __Host- (ohne Cookie-Domain) bzw. __Secure- (mit Domain) in
      // Production — Name zentral in session-cookie.ts (auch proxy.ts liest
      // ihn). Die Optionen hier MÜSSEN zur Präfix-Wahl passen: secure (prod),
      // path '/', domain NUR wenn STAFF_COOKIE_DOMAIN gesetzt (sonst __Host-).
      name: STAFF_SESSION_COOKIE,
      options: {
        httpOnly: true,
        secure: USE_SECURE_COOKIES,
        sameSite: 'lax' as const,
        path: '/',
        // Optional: Subdomain-Trennung (siehe docs/operations/subdomain-trennung.md)
        ...(env.STAFF_COOKIE_DOMAIN ? { domain: env.STAFF_COOKIE_DOMAIN } : {}),
      },
    },
  },

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as StaffTokenPayload;
        token.staffId = u.staffId;
        token.tenantId = u.tenantId;
        token.fullName = u.fullName;
        token.roles = u.roles;
        token.permissions = u.permissions ?? [];
        token.authMethod = u.authMethod;
        token.authRevision = u.authRevision;
        token.sessionIssuedAt = Math.floor(Date.now() / 1000);
        return token;
      }
      // ACCESS-TENANT-RLS-001: Reject before Auth.js issues another cookie.
      // Preserve the original time even if revocation races with this refresh.
      const issuedAt = getSessionIssuedAt(token);
      if (issuedAt === undefined || !hasValidJwtLifetime(token)) return null;
      const session = await hydrateStaffSessionFromToken(
        { user: {}, expires: sessionExpires(token) } as Session,
        token,
      );
      if (!hasStaffSessionFields(session)) return null;
      return { ...token, sessionIssuedAt: issuedAt };
    },
    async session({ session, token }) {
      return hydrateStaffSessionFromToken(session, token);
    },
  },

  pages: {
    signIn: '/staff/login',
  },
};

const _staff = NextAuth(staffConfig);

// Explizite typeof-Annotationen verhindern den TS-Inferenz-Pfad zu
// .pnpm/@auth+core/... (TS4023 in pnpm-Workspaces). Siehe portal.ts.
export const staffHandlers: typeof _staff.handlers = _staff.handlers;
export const staffSignIn: typeof _staff.signIn = _staff.signIn;
export const staffSignOut: typeof _staff.signOut = _staff.signOut;

/** Verifizierter JWT-Subject ohne DB-Hydration, insbesondere für Logout. */
export async function staffSessionSubject(): Promise<string | null> {
  const rawToken = await readStaffSessionTokenCookie();
  if (!rawToken) return null;
  const token = await decodeStaffSessionToken(rawToken);
  return isStaffTokenPayload(token) ? token.staffId : null;
}

// Harter Server-Gatekeeper fuer Staff-Sessions: Cookie prefix-tolerant lesen,
// JWT mit stabilen Salts decodieren und dann dieselben Revocation-/DB-Gates
// wie der NextAuth-Session-Callback pruefen. React cache() dedupliziert diese
// Redis-/DB-Roundtrips request-scoped, ohne Cross-Request-Staleness.
// CI-Haertung: Der Wrapper decodiert das Cookie selbst mit stabilen Salts, damit
// gueltige lokale HTTP-E2E-Sessions nicht von NextAuths auth()-Pipeline verloren
// gehen, bevor unsere eigenen Gates greifen koennen.
export const staffAuth = cache(async (): Promise<StaffSession | null> => {
  const rawToken = await readStaffSessionTokenCookie();
  if (!rawToken) return null;

  const token = await decodeStaffSessionToken(rawToken);
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
