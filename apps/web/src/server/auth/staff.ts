import { cache } from 'react';
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { env } from '@taxtronik/config';
import { decryptTotpSecret, verifyTotpCode } from './totp';
import { resetFailedLogin } from './lockout';
import { recordFailedLoginAudited, auditIp } from './login-audit';
import { isTokenRevoked } from './revocation';
import { STAFF_SESSION_COOKIE, USE_SECURE_COOKIES } from './session-cookie';
import { evidenceService } from '@/server/container';
import { consumeTotpCode } from './totp-replay';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { getClientIp, checkIpOrGlobalLimit, resetRateLimit } from '@/server/rate-limit';
import { fireAndForget } from '@/server/util/fire-and-forget';

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
      (Array.isArray(o['permissions']) && o['permissions'].every((p) => typeof p === 'string')))
  );
}

// Fire-and-forget DB-Updates (Q6): Helfer liegt jetzt zentral in
// @/server/util/fire-and-forget (wird auch von Mail-Side-Effects genutzt).

const staffConfig: NextAuthConfig = {
  basePath: '/api/auth/staff',
  // S9: in Produktion explizit per env opt-in. Dev: implizit true für Komfort.
  trustHost: env.NEXTAUTH_TRUST_HOST ?? (env.NODE_ENV !== 'production'),
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
          log.warn({ ip, bucket: ip ? 'per-ip' : 'global' }, 'staff-auth: authorize-rate-limit hit');
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

        // Konto gesperrt?
        if (staffUser.lockedUntil && staffUser.lockedUntil > new Date()) return null;

        // Passwort prüfen
        const passwordOk = await compare(password, staffUser.passwordHash);
        if (!passwordOk) {
          // Account-gebundener Lockout (S2): IP-RL allein hilft nicht gegen
          // verteilte Brute-Force. Fehler werden geloggt, nicht geschluckt.
          // RF-12: zählt UND schreibt auth.login.failure(/.lockout) in die Chain.
          fireAndForget(
            'recordFailedLogin',
            recordFailedLoginAudited({
              tenantId: tenant.id,
              staffUserId: staffUser.id,
              email: staffUser.email,
              ip,
              reason: 'password',
            }),
          );
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
          fireAndForget('resetFailedLogin', resetFailedLogin(prismaOwner, staffUser.id));
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
          };
        }

        // TOTP ist Pflicht — ohne Enrollment kein Login
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
          ? (staffUser.totpBackupCodes as unknown[]).filter((x): x is string => typeof x === 'string')
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
          fireAndForget(
            'recordFailedLogin (TOTP)',
            recordFailedLoginAudited({
              tenantId: tenant.id,
              staffUserId: staffUser.id,
              email: staffUser.email,
              ip,
              reason: 'totp',
            }),
          );
          return null;
        }

        if (totpValid) {
          // H5: Replay-Schutz. Auch wenn der Code mathematisch gültig ist, darf
          // er pro (staffId, code) nur einmal akzeptiert werden. Fail-closed bei
          // Redis-Ausfall (kein Redis → kein TOTP-Login).
          const fresh = await consumeTotpCode(staffUser.id, totpCode);
          if (fresh === null) {
            log.warn({ staffId: staffUser.id }, 'staff-auth: TOTP-Replay-Store nicht erreichbar — Login abgewiesen');
            return null;
          }
          if (!fresh) {
            fireAndForget(
              'recordFailedLogin (TOTP replay)',
              recordFailedLoginAudited({
                tenantId: tenant.id,
                staffUserId: staffUser.id,
                email: staffUser.email,
                ip,
                reason: 'totp_replay',
              }),
            );
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
            fireAndForget(
              'recordFailedLogin (backup race)',
              recordFailedLoginAudited({
                tenantId: tenant.id,
                staffUserId: staffUser.id,
                email: staffUser.email,
                ip,
                reason: 'backup_code_race',
              }),
            );
            return null;
          }
          log.warn(
            { staffId: staffUser.id, remainingBackupCodes: consumed },
            'staff-auth: TOTP-Backup-Code verwendet (Recovery-Pfad)',
          );
        }

        // Erfolg → Counter resetten (fire-and-forget mit Log) + Last-Login
        // schreiben. RF-12: der Login-Erfolg gehört in die Audit-Hash-Chain
        // (auth.login.success) — in DERSELBEN Tx wie der lastLoginAt-Write
        // (Record-Muster wie überall) und deshalb awaited statt fire-and-forget.
        fireAndForget('resetFailedLogin', resetFailedLogin(prismaOwner, staffUser.id));
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
          // iter87: Einzelrechte MÜSSEN auch im Produktions-Login ins Token —
          // sonst trägt jedes Prod-JWT permissions=[] und der DB-Fallback im
          // session-Callback liefert bei einem transienten DB-Fehler fälschlich
          // „keine Rechte" (asymmetrisch zum roles-Fallback).
          permissions: staffUser.permissions.map((p) => p.permission as string),
        };
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
    jwt({ token, user }) {
      if (user) {
        const u = user as StaffTokenPayload;
        token.staffId = u.staffId;
        token.tenantId = u.tenantId;
        token.fullName = u.fullName;
        token.roles = u.roles;
        token.permissions = u.permissions ?? [];
      }
      return token;
    },
    async session({ session, token }) {
      // Runtime-Check statt blindem Cast (Q9): wenn das Token nicht die
      // erwartete Form hat (JWT-Manipulation, Schema-Drift nach Update,
      // Sessions vor Code-Change), liefern wir die Default-Session ohne
      // Staff-Felder zurück. Aufrufer sehen dann nur das anonyme Session-
      // Schema und werden von der Middleware/Action zum Login geschickt.
      if (!isStaffTokenPayload(token)) return session;

      // S11: Revocation-Check. `token.iat` (Sekunden seit Epoch) wird von
      // NextAuth automatisch gesetzt; revokeAllSessions schreibt einen
      // ms-Timestamp pro Account. Tokens davor sind ungültig.
      const tokenIat = (token as { iat?: number }).iat;
      if (await isTokenRevoked('staff', token.staffId, tokenIat)) {
        // Keine Staff-Felder schreiben → staffAuth-Wrapper liefert null.
        return session;
      }

      // Härtung: Die Session MUSS zu einem existierenden, aktiven Staff-User
      // gehören, dessen Tenant mit dem Token übereinstimmt. Verhindert
      // „Geister-Sessions" — ein JWT aus einem früheren DB-Stand (z. B. nach
      // Re-Seed/Reset) trägt eine Tenant-/User-ID, die nicht mehr existiert.
      // Ohne diese Prüfung würde die App eine solche Session stillschweigend
      // akzeptieren und überall einen leeren, kaputten Zustand zeigen, statt
      // zum Login zu zwingen.
      // F3: Rollen aus DIESEM frischen DB-Stand übernehmen (nicht aus dem bis zu
      // 24 h alten JWT). Der Roundtrip ist für die Ghost-Session-Prüfung ohnehin
      // bezahlt → eine Rollen-Reduktion (z. B. ADMIN entzogen) wirkt sofort, ohne
      // auf revokeAllSessions oder den JWT-Ablauf zu warten. Bleibt null bei
      // transientem DB-Fehler → Fallback auf token.roles (stale, aber kein Logout).
      let freshRoles: string[] | null = null;
      // iter87: Berechtigungen hängen am selben frischen DB-Stand wie die
      // Rollen — ein Entzug (z. B. INVOICE_SEND) wirkt damit sofort, nicht
      // erst nach JWT-Ablauf.
      let freshPermissions: string[] | null = null;
      try {
        const u = await prismaOwner.staffUser.findUnique({
          where: { id: token.staffId },
          select: {
            active: true,
            tenantId: true,
            roles: { select: { role: true } },
            permissions: { select: { permission: true } },
          },
        });
        if (!u || !u.active || u.tenantId !== token.tenantId) {
          log.warn(
            { staffId: token.staffId, tokenTenant: token.tenantId },
            'staff-auth: Session ohne gültigen User/Tenant — invalidiert (Re-Login erzwungen)',
          );
          return session; // keine Staff-Felder → staffAuth liefert null
        }
        freshRoles = u.roles.map((r) => r.role as string);
        freshPermissions = u.permissions.map((p) => p.permission as string);
      } catch (err) {
        // Transienter DB-Fehler darf nicht alle ausloggen — loggen, durchlassen.
        log.warn(
          { err: (err as Error).message },
          'staff-auth: Session-Existenzprüfung fehlgeschlagen — durchgelassen',
        );
      }

      session.user.staffId = token.staffId;
      session.user.tenantId = token.tenantId;
      session.user.fullName = token.fullName;
      session.user.roles = freshRoles ?? token.roles;
      session.user.permissions = freshPermissions ?? token.permissions ?? [];
      return session;
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

// Wrapper, der auf das narrower StaffSession-Typ castet. Aufrufer können
// `session.user.staffId` / `roles` ohne `?` benutzen, weil im staff-Surface
// die Credentials-Provider-`authorize` diese Felder garantiert. Zusätzlich:
// wenn der Revocation-Check im session-Callback die Staff-Felder nicht
// gesetzt hat (S11), liefern wir null statt einer halb-leeren Session.
// React cache(): dedupliziert pro Request. staffAuth wird im (protected)/layout
// UND in jeder Page darunter (bei verschachtelten Layouts sogar 3×) aufgerufen;
// jeder Aufruf triggert sonst den Session-Callback = 1 Redis-Revocation-Check +
// 1 DB-findUnique (Ghost-Session-Härtung). cache() ist request-scoped (nie über
// Requests/User hinweg) → null Staleness-/Leak-Risiko, redundante Round-Trips weg.
export const staffAuth = cache(async (): Promise<StaffSession | null> => {
  const raw = await _staff.auth();
  if (!raw?.user) return null;
  const u = raw.user as { staffId?: string };
  if (!u.staffId) return null;
  return raw as StaffSession;
});
