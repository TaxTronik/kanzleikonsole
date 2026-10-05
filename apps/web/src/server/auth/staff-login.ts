// =============================================================================
// Staff-Login-Service (R-04): die einzige Implementierung der Passwort-/TOTP-
// Anmeldung.
//
//   Schritt 1  authenticateStaffPassword (checkPasswordAction, darüber auch der
//              lokale Formularpfad): Konto-Lookup, Sperr-/Moduswahl, Limits,
//              genau ein bcrypt-Vergleich (S-09), Fehlversuchs-Audit.
//              Danach stellt issueStaffLoginTicketFor ein Einmal-Ticket aus.
//   Schritt 2  completeStaffLogin (Auth.js-authorize, lokaler DEV-Pfad) bzw.
//              redeemStaffLoginTicket (Erst-Enrollment): verbraucht das an
//              staffId, authRevision und Passwort-Hash gebundene Ticket,
//              prüft TOTP/Backup-Code (bzw. DEV_SKIP_TOTP) und schreibt Erfolg
//              und Audit. Das Passwort wird dort nicht erneut geprüft — eine
//              Anmeldung kostet einen Passwort-bcrypt statt zwei.
// =============================================================================

import bcrypt from 'bcryptjs';
import type { StaffUser } from '@prisma/client';
import { env } from '@taxtronik/config';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import {
  checkIpOrGlobalLimit,
  checkStaffPasswordAccountLimit,
  checkStaffSecondFactorAccountLimit,
  resetRateLimit,
  staffSecondFactorAccountRateLimitKey,
} from '@/server/rate-limit';
import { resetFailedLogin } from './lockout';
import { auditIp, recordFailedLoginAudited } from './login-audit';
import { decryptTotpSecret, verifyTotpCode } from './totp';
import { consumeTotpCode } from './totp-replay';
import type { StaffAuthMethod } from './staff-auth-state';
import type { StaffSessionUser } from './staff-session';
import { passwordLoginAccount, verifyStaffPassword } from './staff-password';
import {
  consumeStaffLoginTicket,
  issueStaffLoginTicket,
  staffLoginTicketMatches,
  type StaffLoginTicketAccount,
  type StaffLoginTicketPurpose,
} from './staff-login-ticket';

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

// Backup-Codes bestehen aus genau zehn Zeichen des Enrollment-Alphabets
// (Großbuchstaben/Ziffern). Andere Eingaben — insbesondere ein falscher
// sechsstelliger TOTP — können keinen Code treffen und kosten deshalb keine
// bis zu acht bcrypt-Vergleiche im Hauptthread.
const BACKUP_CODE_INPUT = /^[0-9A-Z]{10}$/;

type StaffAccount = StaffUser & {
  roles: { role: string }[];
  permissions: { permission: string }[];
};

export type StaffPasswordStepResult =
  | { ok: true; account: StaffUser; tenantId: string }
  | { ok: false };

/**
 * Schritt 1. S-09/M2: unbekannte Kanzlei, unbekanntes, deaktiviertes,
 * gesperrtes oder Hardware-only-Konto und falsches Passwort sind nach außen
 * gleich (ein Ergebnis, genau ein bcrypt-Vergleich). S-03: Das
 * Passwortkontingent eines existierenden Kontos wird vor bcrypt geprüft.
 */
export async function authenticateStaffPassword(input: {
  email: string;
  password: string;
  tenantSlug: string;
  ip: string | null;
}): Promise<StaffPasswordStepResult> {
  const tenant = await prismaOwner.tenant.findFirst({ where: { slug: input.tenantSlug } });
  const candidate = tenant
    ? await prismaOwner.staffUser.findFirst({
        where: { tenantId: tenant.id, email: input.email.toLowerCase() },
      })
    : null;

  const account = passwordLoginAccount(candidate);
  if (account) {
    const accountRl = await checkStaffPasswordAccountLimit(account.id);
    if (!accountRl.ok) {
      log.warn({ staffId: account.id }, 'staff-auth: account password-rate-limit hit');
      return { ok: false };
    }
  }

  const passwordOk = await verifyStaffPassword(input.password, account);
  if (!tenant || !account) return { ok: false };
  if (!passwordOk) {
    // Account-gebundener Lockout (S2 + L-4): erst bei N distinkten Quell-IPs;
    // ohne bekannte IP wird nur gezählt (S-03). RF-12: zählt UND schreibt
    // auth.login.failure(/.lockout) in die Audit-Chain.
    await recordFailedLoginAudited({
      tenantId: tenant.id,
      staffUserId: account.id,
      email: account.email,
      ip: input.ip,
      reason: 'password',
    }).catch((error: unknown) => {
      // F-05: Das generische Ergebnis bleibt; ein verlorener Lockout-Zähler
      // schwächt aber den Schutz für diesen Versuch und gehört ins Log.
      log.error(
        {
          component: 'staff-login',
          tenantId: tenant.id,
          staffId: account.id,
          reason: 'password',
          err: error instanceof Error ? error.message : String(error),
        },
        'staff-login: Fehlversuch weder gezählt noch auditiert (Lockout-Zähler)',
      );
    });
    return { ok: false };
  }
  return { ok: true, account, tenantId: tenant.id };
}

/** Einmal-Ticket für den zweiten Schritt; null, wenn Redis es nicht speichern kann. */
export async function issueStaffLoginTicketFor(
  purpose: StaffLoginTicketPurpose,
  account: StaffLoginTicketAccount,
): Promise<string | null> {
  try {
    return await issueStaffLoginTicket(purpose, account);
  } catch (error) {
    log.warn(
      { staffId: account.id, err: (error as Error).message },
      'staff-auth: Anmeldeticket nicht verfügbar - Anmeldung abgewiesen',
    );
    return null;
  }
}

/**
 * Verbraucht das Ticket und lädt das Konto. ACCESS-TENANT-RLS-001: Nur exakt
 * der im Passwortschritt bewiesene Stand (Revision, Passwort-Hash, Tenant)
 * eines weiterhin aktiven, ungesperrten Passwortkontos wird angenommen.
 */
export async function redeemStaffLoginTicket(
  ticket: unknown,
  purpose: StaffLoginTicketPurpose,
): Promise<{ account: StaffAccount; tenantId: string } | null> {
  const binding = await consumeStaffLoginTicket(ticket, purpose);
  if (!binding) return null;
  const account = passwordLoginAccount(
    await prismaOwner.staffUser.findFirst({
      where: { id: binding.staffId, tenantId: binding.tenantId },
      include: { roles: true, permissions: true },
    }),
  );
  if (!account || !staffLoginTicketMatches(binding, account)) {
    log.warn(
      { staffId: binding.staffId },
      'staff-auth: Konto seit dem Passwortschritt geändert - Anmeldeticket verworfen',
    );
    return null;
  }
  return { account, tenantId: binding.tenantId };
}

async function mayVerifySecondFactor(staffId: string, code: string): Promise<boolean> {
  if (!code) return false;
  // ACCESS-TENANT-RLS-001: Kenntnis des Passworts genügt nicht, um
  // verteilte TOTP-/Backup-Code-Versuche zurückzusetzen. Dieser Bucket
  // ist unabhängig vom Passwortvorschritt und allen IP-Buckets.
  return (await checkStaffSecondFactorAccountLimit(staffId)).ok;
}

function sessionUser(
  account: StaffAccount,
  tenantId: string,
  authMethod: StaffAuthMethod,
): StaffSessionUser {
  return {
    id: account.id,
    email: account.email,
    name: account.fullName,
    staffId: account.id,
    tenantId,
    fullName: account.fullName,
    roles: account.roles.map((r) => r.role as string),
    // iter87: Einzelrechte MÜSSEN auch im Produktions-Login ins Token,
    // damit alte und neue JWT-Schemata sauber unterschieden werden.
    permissions: account.permissions.map((p) => p.permission as string),
    authMethod,
    authRevision: account.authRevision,
  };
}

type LoginContext = { account: StaffAccount; tenantId: string; ip: string | null };

function recordSecondFactorFailure(
  { account, tenantId, ip }: LoginContext,
  reason: 'totp' | 'totp_replay' | 'backup_code_race',
): Promise<void> {
  return recordFailedLoginAudited({
    tenantId,
    staffUserId: account.id,
    email: account.email,
    ip,
    reason,
  });
}

/**
 * V-1: Backup-Code-Recovery. Wenn TOTP nicht matched, prüfen wir gegen die
 * hashedTotpBackupCodes (8 one-time-use codes aus dem Enrollment). bcrypt-
 * compare ist teuer (12 rounds × 8 codes = ~1s im Worst Case), aber das ist
 * der Recovery-Pfad — Latenz ist hier akzeptabel. Eingaben, die kein
 * Backup-Code sein können, vergleichen wir gar nicht erst (R-04).
 */
async function matchingBackupCodeHash(account: StaffAccount, code: string): Promise<string | null> {
  if (!BACKUP_CODE_INPUT.test(code)) return null;
  // totpBackupCodes ist im Schema Json? — wir holen die String-Liste raus.
  const backupCodes: string[] = Array.isArray(account.totpBackupCodes)
    ? (account.totpBackupCodes as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  for (const hashed of backupCodes) {
    if (await bcrypt.compare(code, hashed)) return hashed;
  }
  return null;
}

/**
 * V-1/W-3: Backup-Code one-time-use atomar konsumieren: SELECT FOR UPDATE +
 * Re-Check innerhalb $transaction, dann UPDATE — awaited, damit weder ein
 * transienter Fehler noch ein paralleler Login den Code „zurückholt".
 */
async function consumeBackupCode(context: LoginContext, usedHash: string): Promise<boolean> {
  const { account, tenantId, ip } = context;
  const consumed = await prismaOwner.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ totp_backup_codes: unknown }[]>`
      SELECT totp_backup_codes FROM staff_user
      WHERE id = ${account.id}::uuid
      FOR UPDATE
    `;
    const current: string[] = Array.isArray(rows[0]?.totp_backup_codes)
      ? (rows[0]!.totp_backup_codes as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const idx = current.indexOf(usedHash);
    if (idx < 0) {
      // Anderer Login hat denselben Code zwischenzeitlich konsumiert.
      return false;
    }
    const remaining = current.filter((_, i) => i !== idx);
    await tx.staffUser.update({
      where: { id: account.id },
      data: { totpBackupCodes: remaining },
    });
    // RF-12: One-Time-Verbrauch eines Backup-Codes ist sicherheits-
    // relevant (umgeht TOTP) → in DERSELBEN Tx in die Audit-Chain.
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: account.id,
      action: 'auth.backup_code.consume',
      resourceType: 'staff_user',
      resourceId: account.id,
      after: { email: account.email, remainingBackupCodes: remaining.length },
      ip: auditIp(ip),
    });
    return remaining.length;
  });
  if (consumed === false) {
    log.warn(
      { staffId: account.id },
      'staff-auth: TOTP-Backup-Code Race verloren — Login abgewiesen',
    );
    await recordSecondFactorFailure(context, 'backup_code_race');
    return false;
  }
  log.warn(
    { staffId: account.id, remainingBackupCodes: consumed },
    'staff-auth: TOTP-Backup-Code verwendet (Recovery-Pfad)',
  );
  return true;
}

/** TOTP oder Backup-Code; liefert die Anmeldemethode oder null (abgewiesen). */
async function verifyStaffSecondFactor(
  context: LoginContext,
  code: string,
): Promise<'totp' | 'backup_code' | null> {
  const { account, tenantId } = context;
  // TOTP ist Pflicht — ohne Enrollment kein Login
  if (!account.totpSecretEnc || !account.totpEnrolledAt) return null;
  if (!(await mayVerifySecondFactor(account.id, code))) return null;

  const secret = decryptTotpSecret(account.totpSecretEnc, tenantId, env.AUTH_SECRET);
  if (verifyTotpCode(code, secret)) {
    // H5: Replay-Schutz. Auch wenn der Code mathematisch gültig ist, darf
    // er pro (staffId, code) nur einmal akzeptiert werden. Fail-closed bei
    // Redis-Ausfall (kein Redis → kein TOTP-Login).
    const fresh = await consumeTotpCode(account.id, code);
    if (fresh === null) {
      log.warn(
        { staffId: account.id },
        'staff-auth: TOTP-Replay-Store nicht erreichbar — Login abgewiesen',
      );
      return null;
    }
    if (!fresh) {
      await recordSecondFactorFailure(context, 'totp_replay');
      return null;
    }
    return 'totp';
  }

  const usedHash = await matchingBackupCodeHash(account, code);
  if (!usedHash) {
    await recordSecondFactorFailure(context, 'totp');
    return null;
  }
  return (await consumeBackupCode(context, usedHash)) ? 'backup_code' : null;
}

/**
 * Erfolg → Counter vollständig zurücksetzen, bevor der Login als erfolgreich
 * zurückgegeben wird. Sonst kann ein noch laufender Fehlversuch-Write den
 * erfolgreichen Reset zeitlich überholen. RF-12: der Login-Erfolg gehört in
 * die Audit-Hash-Chain (auth.login.success) — in DERSELBEN Tx wie der
 * lastLoginAt-Write (Record-Muster wie überall) und deshalb awaited statt
 * fire-and-forget.
 */
async function recordStaffLoginSuccess(
  { account, tenantId, ip }: LoginContext,
  method: 'totp' | 'backup_code',
): Promise<void> {
  await resetFailedLogin(prismaOwner, account.id);
  // Die gemeinsame Sturm-Obergrenze ohne IP leert ein Login nicht (S-03).
  if (ip) await resetRateLimit(`staff-authorize:${ip}`);
  await prismaOwner.$transaction(async (tx) => {
    await tx.staffUser.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: account.id,
      action: 'auth.login.success',
      resourceType: 'staff_user',
      resourceId: account.id,
      after: { email: account.email, method },
      ip: auditIp(ip),
    });
  });
  await resetRateLimit(staffSecondFactorAccountRateLimitKey(account.id));
}

/** DEV-ONLY: Login ohne zweiten Faktor; doppelt gegated über DEV_SKIP_TOTP. */
async function completeDevLogin({ account, tenantId, ip }: LoginContext): Promise<void> {
  log.warn(
    { staffId: account.id },
    'staff-auth: DEV_SKIP_TOTP aktiv — TOTP übersprungen (NUR Dev!)',
  );
  if (ip) await resetRateLimit(`staff-authorize:${ip}`);
  await resetFailedLogin(prismaOwner, account.id);
  // RF-12: auch der Dev-Login landet in der Chain (method markiert ihn).
  await prismaOwner.$transaction((tx) =>
    evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: account.id,
      action: 'auth.login.success',
      resourceType: 'staff_user',
      resourceId: account.id,
      after: { email: account.email, method: 'dev_skip_totp' },
      ip: auditIp(ip),
    }),
  );
}

/**
 * Schritt 2: Ticket einlösen, zweiten Faktor prüfen, Erfolg protokollieren.
 * Gemeinsamer Pfad für den Auth.js-Credentials-Provider und den lokalen
 * DEV-Formularpfad. null = Anmeldung abgewiesen (das Ticket ist verbraucht).
 */
export async function completeStaffLogin(input: {
  loginTicket: unknown;
  totpCode: string;
  ip: string | null;
}): Promise<StaffSessionUser | null> {
  const { ip, totpCode } = input;
  // Ein fehlendes Ticket bzw. ein fehlender Code verbraucht weder IP-Kontingent
  // noch Ticket noch Second-Factor-Kontingent.
  if (typeof input.loginTicket !== 'string' || !input.loginTicket) return null;
  if (!DEV_SKIP_TOTP && !totpCode) return null;

  // K1+N3: IP-Limit vor jedem Lookup. Per-IP eng, bei null-IP nur die
  // großzügige Sturm-Obergrenze (S-03); pro Konto deckelt das
  // Second-Factor-Limit. Hintergrund siehe docs/compliance/tenancy-model.md.
  const rl = await checkIpOrGlobalLimit('staff-authorize', ip, { max: 10, windowSec: 600 });
  if (!rl.ok) {
    log.warn({ ip, bucket: ip ? 'per-ip' : 'global' }, 'staff-auth: authorize-rate-limit hit');
    return null;
  }

  const redeemed = await redeemStaffLoginTicket(input.loginTicket, 'second-factor');
  if (!redeemed) return null;
  const context: LoginContext = { ...redeemed, ip };

  if (DEV_SKIP_TOTP) {
    await completeDevLogin(context);
    return sessionUser(context.account, context.tenantId, 'dev_skip_totp');
  }

  const method = await verifyStaffSecondFactor(context, totpCode);
  if (!method) return null;
  await recordStaffLoginSuccess(context, method);
  return sessionUser(context.account, context.tenantId, method);
}
