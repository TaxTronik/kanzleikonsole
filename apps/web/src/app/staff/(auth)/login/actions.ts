'use server';

import bcrypt from 'bcryptjs';
import type { StaffUser } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import QRCode from 'qrcode';
import {
  generateTotpSecret,
  buildTotpUri,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
} from '@/server/auth/totp';
import { staffSignIn, DEV_SKIP_TOTP } from '@/server/auth/staff';
import { resetFailedLogin } from '@/server/auth/lockout';
import { passwordAuthenticationBlocked } from '@/server/auth/staff-password';
import {
  authenticateStaffPassword,
  issueStaffLoginTicketFor,
  redeemStaffLoginTicket,
} from '@/server/auth/staff-login';
import type { StaffLoginTicketPurpose } from '@/server/auth/staff-login-ticket';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { fireAndForget } from '@/server/util/fire-and-forget';
import {
  checkIpOrGlobalLimit,
  checkRateLimit,
  getClientIp,
  resetRateLimit,
  staffPasswordAccountRateLimitKey,
} from '@/server/rate-limit';
import { env } from '@taxtronik/config';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import {
  beginHardwareLogin,
  isAuthenticationResponse,
  isHardwareAccessConfigured,
} from '@/server/auth/webauthn';

const { hash } = bcrypt;

// Crockford-Base32 ohne verwechselbare Glyphen (kein I/L/O/U).
// 32 Zeichen → 5 Bit pro Zeichen. 10 Zeichen = 50 Bit Entropie pro Backup-Code.
const BACKUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const BACKUP_CODE_LENGTH = 10;
const TOTP_SETUP_TTL_MS = 60 * 60 * 1000;
const TOTP_ENROLLMENT_LIMIT = { max: 5, windowSec: 300 } as const;
const STAFF_PASSWORD_IP_LIMIT = { max: 10, windowSec: 600 } as const;
const GENERIC_LOGIN_ERROR = 'Ungültige Anmeldedaten.';
const LOGIN_UNAVAILABLE_ERROR = 'Anmeldung derzeit nicht möglich. Bitte später erneut versuchen.';
const LOGIN_RESTART_ERROR = 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.';

type PasswordBoundAccount = Pick<StaffUser, 'id' | 'tenantId' | 'passwordHash' | 'authRevision'> & {
  active: true;
  hardwareOnlyEnabledAt: null;
};

function totpEnrollmentAccountRateLimitKey(staffUserId: string): string {
  return `staff-totp-enroll-account:${staffUserId}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function generateBackupCode(): string {
  // Rejection-Sampling: nur Bytes < 240 verwenden (240 = 8 * 30) → uniforme
  // Verteilung über die 30 Zeichen ohne Modulo-Bias.
  const out: string[] = [];
  while (out.length < BACKUP_CODE_LENGTH) {
    const buf = randomBytes(BACKUP_CODE_LENGTH * 2);
    for (let i = 0; i < buf.length && out.length < BACKUP_CODE_LENGTH; i++) {
      const b = buf[i]!;
      if (b < 240) out.push(BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length]!);
    }
  }
  return out.join('');
}

export interface CheckPasswordResult {
  ok: boolean;
  totpRequired?: boolean;
  totpSetupRequired?: boolean;
  setupSecret?: string;
  /**
   * Q-1: PNG-Data-URL des QR-Codes, serverseitig generiert. Die rohe otpauth://-
   * URI mit eingebettetem TOTP-Secret darf NICHT an einen externen Dienst gehen
   * (vorher: api.qrserver.com — Secret-Leak in Drittanbieter-Logs). data:-URL
   * passt zur CSP `img-src 'self' data: blob:`.
   */
  setupQrDataUrl?: string;
  /** DEV-ONLY: TOTP übersprungen → UI loggt direkt ein (siehe DEV_SKIP_TOTP). */
  devSkip?: boolean;
  /**
   * R-04: Einmal-Ticket für den zweiten Schritt (TOTP/Backup-Code, Erst-Setup
   * oder DEV-Login). Fünf Minuten gültig, an Konto, authRevision und
   * Passwort-Hash gebunden; der zweite Schritt prüft das Passwort nicht erneut.
   */
  loginTicket?: string;
  error?: string;
}

export async function checkPasswordAction(
  email: string,
  password: string,
  tenantSlug: string = 'default',
): Promise<CheckPasswordResult> {
  if (!email || !password) {
    return { ok: false, error: 'E-Mail und Passwort sind Pflichtfelder.' };
  }

  // Rate-Limit pro IP — 10 Versuche / 10 Minuten. Ohne IP nur die großzügige
  // Sturm-Obergrenze (S-03); pro Konto deckelt checkStaffPasswordAccountLimit.
  const ip = getClientIp(await headers());
  const rl = await checkIpOrGlobalLimit('staff-pw', ip, STAFF_PASSWORD_IP_LIMIT);
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Versuche. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  // R-04/S-09: Konto-Lookup, Sperr-/Moduswahl, Kontolimit, genau ein
  // bcrypt-Vergleich (auch für unbekannte oder unzulässige Konten) und
  // Fehlversuchs-Audit stecken im Staff-Login-Service; nach außen sind alle
  // Ablehnungen gleich.
  const authenticated = await authenticateStaffPassword({ email, password, tenantSlug, ip });
  if (!authenticated.ok) {
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  // ACCESS-TENANT-RLS-001: bcrypt may overlap a reset, enrollment or mode
  // change. Bind every setup read/write and the login ticket to the password
  // and revision proved above; never adopt a newer authentication state for
  // the old password.
  const passwordBoundAccount: PasswordBoundAccount = {
    id: authenticated.account.id,
    tenantId: authenticated.tenantId,
    passwordHash: authenticated.account.passwordHash,
    authRevision: authenticated.account.authRevision,
    active: true,
    hardwareOnlyEnabledAt: null,
  };
  const staffUser = await prismaOwner.staffUser.findFirst({ where: passwordBoundAccount });
  if (!staffUser || passwordAuthenticationBlocked(staffUser)) {
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  // Erfolg → Counter zurücksetzen (IP-RL + Account-Counter). Die gemeinsame
  // Sturm-Obergrenze ohne IP leert ein einzelner Login nicht (S-03).
  if (ip) await resetRateLimit(`staff-pw:${ip}`);
  await resetRateLimit(staffPasswordAccountRateLimitKey(staffUser.id));
  fireAndForget('staff-login: resetFailedLogin', resetFailedLogin(prismaOwner, staffUser.id));

  // R-04: Der zweite Schritt prüft das Passwort nicht erneut, sondern löst ein
  // kurzlebiges Einmal-Ticket für genau diesen Kontostand ein.
  // DEV-ONLY: TOTP überspringen → UI loggt direkt ein (ohne Code/Setup).
  if (DEV_SKIP_TOTP) {
    return withLoginTicket('second-factor', passwordBoundAccount, { ok: true, devSkip: true });
  }

  // TOTP bereits eingerichtet?
  if (staffUser.totpEnrolledAt && staffUser.totpSecretEnc) {
    return withLoginTicket('second-factor', passwordBoundAccount, {
      ok: true,
      totpRequired: true,
    });
  }

  const setup = await prepareTotpSetup(staffUser, passwordBoundAccount);
  return setup.ok ? withLoginTicket('totp-enrollment', passwordBoundAccount, setup) : setup;
}

async function withLoginTicket(
  purpose: StaffLoginTicketPurpose,
  passwordBoundAccount: PasswordBoundAccount,
  result: CheckPasswordResult,
): Promise<CheckPasswordResult> {
  const loginTicket = await issueStaffLoginTicketFor(purpose, passwordBoundAccount);
  // Ohne Ticket kein zweiter Schritt — und auch kein Setup-Secret ausgeben.
  return loginTicket ? { ...result, loginTicket } : { ok: false, error: LOGIN_UNAVAILABLE_ERROR };
}

async function prepareTotpSetup(
  staffUser: Pick<StaffUser, 'email' | 'totpSecretEnc' | 'totpSetupStartedAt'>,
  passwordBoundAccount: PasswordBoundAccount,
): Promise<CheckPasswordResult> {
  // Erste Anmeldung: TOTP-Setup. Wenn bereits ein Secret existiert (Setup
  // begonnen, aber Bestätigung noch offen), das bestehende Secret zurückgeben
  // statt zu überschreiben — sonst kann ein Angreifer mit Passwort den
  // Setup-QR-Code beliebig oft rotieren lassen.
  //
  // M-3: Setup-Fenster ist auf 60 min ab erster Generierung begrenzt. Wenn
  // der initial-Admin sein Setup nicht in 60 min abschließt, wird der Setup-
  // Versuch abgelehnt — Account muss vom Admin neu provisioniert werden
  // (Out-of-Band). Verhindert, dass ein Angreifer mit Initialpasswort nach
  // Stunden/Tagen den QR-Code abruft.
  if (
    staffUser.totpSecretEnc &&
    staffUser.totpSetupStartedAt &&
    Date.now() - staffUser.totpSetupStartedAt.getTime() > TOTP_SETUP_TTL_MS
  ) {
    return {
      ok: false,
      error:
        'TOTP-Setup-Fenster abgelaufen. Bitte ADMIN/PARTNER kontaktieren, um den Account neu zu provisionieren.',
    };
  }

  const authSecret = env.AUTH_SECRET;
  let rawSecret: string;
  let encSecret = staffUser.totpSecretEnc;
  if (staffUser.totpSecretEnc) {
    rawSecret = decryptTotpSecret(
      staffUser.totpSecretEnc,
      passwordBoundAccount.tenantId,
      authSecret,
    );
  } else {
    rawSecret = generateTotpSecret();
    encSecret = encryptTotpSecret(rawSecret, passwordBoundAccount.tenantId, authSecret);
    const initialized = await prismaOwner.staffUser.updateMany({
      where: {
        ...passwordBoundAccount,
        totpSecretEnc: null,
        totpEnrolledAt: null,
        totpSetupStartedAt: staffUser.totpSetupStartedAt,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
      },
      data: {
        totpSecretEnc: encSecret,
        totpEnrolledAt: null,
        totpSetupStartedAt: new Date(),
      },
    });
    if (initialized.count !== 1) return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  const qrUri = buildTotpUri(staffUser.email, rawSecret);

  // Q-1: QR-Code lokal als PNG-data-URL rendern. Vorher generierte die UI
  // einen <img src="api.qrserver.com?data=…otpauth://…secret=RAW…">; jede
  // Anfrage hätte das TOTP-Secret im Klartext an einen Drittanbieter geleakt.
  // Faktisch durch CSP (img-src 'self' data: blob:) blockiert — der QR-Code
  // wurde nie geladen, Staff musste das 38-Zeichen-Secret manuell tippen.
  // Jetzt: serverseitig erzeugte data:image/png — passt zur CSP, kein
  // externer Roundtrip, funktioniert air-gapped.
  const setupQrDataUrl = await QRCode.toDataURL(qrUri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });

  // QR generation also yields. Do not disclose a secret whose account or
  // pending setup has meanwhile been replaced or confirmed.
  const pending = await prismaOwner.staffUser.findFirst({
    where: {
      ...passwordBoundAccount,
      totpSecretEnc: encSecret,
      totpEnrolledAt: null,
      totpSetupStartedAt: { gte: new Date(Date.now() - TOTP_SETUP_TTL_MS) },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
    },
    select: { id: true },
  });
  if (!pending) return { ok: false, error: GENERIC_LOGIN_ERROR };

  return {
    ok: true,
    totpSetupRequired: true,
    setupSecret: rawSecret,
    setupQrDataUrl,
  };
}

export interface ConfirmEnrollmentResult {
  ok: boolean;
  error?: string;
  /**
   * V-1: Frisch generierte Backup-Codes — werden EINMAL bei der TOTP-
   * Bestätigung zurückgegeben. Der Server speichert nur bcrypt-Hashes
   * und kann sie danach nie wieder anzeigen. Der User MUSS sie
   * herunterladen/ausdrucken; ohne Backup-Codes und ohne Authenticator-
   * Device ist der Account dauerhaft ausgesperrt (Admin muss neu
   * provisionieren).
   */
  backupCodes?: string[];
  /** R-04: neues Einmal-Ticket für den anschließenden TOTP-Login (neue Revision). */
  loginTicket?: string;
}

export async function confirmTotpEnrollmentAction(
  loginTicket: string,
  totpCode: string,
): Promise<ConfirmEnrollmentResult> {
  // P0-3: öffentlich aufrufbar — das IP-/Sturm-Limit greift vor jedem Lookup.
  const ip = getClientIp(await headers());
  const enrollmentIpRl = await checkIpOrGlobalLimit('staff-totp-enroll', ip, TOTP_ENROLLMENT_LIMIT);
  if (!enrollmentIpRl.ok) {
    return { ok: false, error: 'Zu viele Bestätigungsversuche. Bitte kurz warten.' };
  }

  // R-04: kein zweiter Passwortvergleich. Das Einmal-Ticket aus dem
  // Passwortschritt bindet Konto, Tenant, authRevision und Passwort-Hash eines
  // weiterhin aktiven, ungesperrten Passwortkontos; es ist danach verbraucht.
  const redeemed = await redeemStaffLoginTicket(loginTicket, 'totp-enrollment');
  if (!redeemed) return { ok: false, error: LOGIN_RESTART_ERROR };
  const { account: staffUser, tenantId } = redeemed;

  // Erst nach eingelöstem Ticket accountgebunden zählen. Sonst könnte ein
  // Fremder allein mit einer bekannten E-Mail das offene Erst-Setup sperren.
  const enrollmentAccountKey = totpEnrollmentAccountRateLimitKey(staffUser.id);
  const enrollmentAccountRl = await checkRateLimit(enrollmentAccountKey, TOTP_ENROLLMENT_LIMIT);
  if (!enrollmentAccountRl.ok) {
    return { ok: false, error: 'Zu viele Bestätigungsversuche. Bitte kurz warten.' };
  }

  // Enrollment ist ausschließlich für das noch offene Erst-Setup zulässig.
  // Ein bereits eingeschriebenes Konto darf über diese öffentliche Action
  // insbesondere keine neuen Backup-Codes erzeugen.
  if (staffUser.totpEnrolledAt) {
    return { ok: false, error: 'TOTP ist bereits eingerichtet.' };
  }
  if (!staffUser.totpSecretEnc || !staffUser.totpSetupStartedAt) {
    return { ok: false, error: 'Kein offenes TOTP-Setup gefunden.' };
  }
  const setupCutoff = new Date(Date.now() - TOTP_SETUP_TTL_MS);
  if (staffUser.totpSetupStartedAt < setupCutoff) {
    return { ok: false, error: 'TOTP-Setup-Fenster abgelaufen.' };
  }

  const rawSecret = decryptTotpSecret(staffUser.totpSecretEnc, tenantId, env.AUTH_SECRET);

  if (!verifyTotpCode(totpCode, rawSecret)) {
    // Das Ticket ist verbraucht: neuer Versuch über die Passwortanmeldung.
    return { ok: false, error: 'Ungültiger Bestätigungs-Code. Bitte erneut anmelden.' };
  }

  // Backup-Codes generieren (8 Codes à 10 Zeichen, ~50 Bit Entropie pro Code).
  // crypto.randomBytes — Math.random() ist nicht kryptographisch sicher und
  // Backup-Codes umgehen TOTP komplett, müssen also mindestens so stark sein
  // wie das TOTP-Secret.
  const backupCodes = Array.from({ length: 8 }, generateBackupCode);
  const hashedBackupCodes = await Promise.all(backupCodes.map((c) => hash(c, 12)));

  // RF-12: das TOTP-Enrollment ist die Wurzel der 2FA-Vertrauenskette → in
  // DERSELBEN Tx wie die Mutation in die Audit-Hash-Chain (auth.totp.enroll).
  const enrolled = await prismaOwner.$transaction(async (tx) => {
    // Conditional Update ist der atomare Einmal-Claim: parallele Requests und
    // ein zwischenzeitliches Admin-Reset können das Enrollment nicht zweimal
    // abschließen oder einen neueren Setup-Stand überschreiben.
    const claimed = await tx.staffUser.updateMany({
      where: {
        id: staffUser.id,
        tenantId,
        passwordHash: staffUser.passwordHash,
        authRevision: staffUser.authRevision,
        active: true,
        hardwareOnlyEnabledAt: null,
        totpEnrolledAt: null,
        totpSecretEnc: staffUser.totpSecretEnc,
        totpSetupStartedAt: { gte: setupCutoff },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
      },
      data: {
        totpEnrolledAt: new Date(),
        totpSetupStartedAt: null,
        totpBackupCodes: hashedBackupCodes,
        authRevision: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return false;
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffUser.id,
      action: 'auth.totp.enroll',
      resourceType: 'staff_user',
      resourceId: staffUser.id,
      after: { email: staffUser.email, backupCodesIssued: backupCodes.length },
    });
    return true;
  });
  if (!enrolled) {
    return { ok: false, error: 'TOTP-Setup wurde bereits abgeschlossen oder geändert.' };
  }

  // Erst der vollständig erfolgreiche Einmal-Claim darf die Versuchszähler
  // leeren. Bei falschem TOTP bleiben alle Buckets erhalten. Die gemeinsame
  // Sturm-Obergrenze ohne IP bleibt unberührt (S-03). Die Passwort-Buckets hat
  // bereits der Passwortschritt geleert.
  if (ip) await resetRateLimit(`staff-totp-enroll:${ip}`);
  await resetRateLimit(enrollmentAccountKey);
  fireAndForget('staff-login: resetFailedLogin', resetFailedLogin(prismaOwner, staffUser.id));

  // R-04: Das Enrollment hat die Revision erhöht und das Ticket verbraucht.
  // Der anschließende TOTP-Login bekommt ein neues, an die neue Revision
  // gebundenes Ticket; ohne Redis meldet sich der Nutzer danach neu an.
  const nextTicket = await issueStaffLoginTicketFor('second-factor', {
    id: staffUser.id,
    tenantId,
    passwordHash: staffUser.passwordHash,
    authRevision: staffUser.authRevision + 1,
  });

  // V-1: Rohe Codes EINMAL an den Client zurück. Vorher waren sie tot in der
  // DB — User wussten nichts davon, Phone-Verlust = dauerhaft ausgesperrt,
  // Admin musste neu provisionieren. Jetzt ist Recovery-Pfad funktional.
  return { ok: true, backupCodes, ...(nextTicket ? { loginTicket: nextTicket } : {}) };
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

function safeStaffReturnTo(raw: unknown): string {
  if (typeof raw !== 'string') return '/staff/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/staff/dashboard';
  if (!raw.startsWith('/staff/') || raw.includes('\\')) return '/staff/dashboard';
  return raw;
}

export type BeginHardwareLoginResult =
  | { ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { error: string };

export async function hardwareLoginAvailabilityAction(): Promise<{ available: boolean }> {
  return { available: isHardwareAccessConfigured() };
}

export async function beginHardwareLoginAction(): Promise<BeginHardwareLoginResult> {
  const ip = getClientIp(await headers());
  const rate = await checkIpOrGlobalLimit('staff-hardware-begin', ip, { max: 20, windowSec: 300 });
  if (!rate.ok) return { error: 'Zu viele Anmeldeversuche. Bitte kurz warten.' };
  try {
    return await beginHardwareLogin();
  } catch (err) {
    log.error(
      { component: 'staff-login', err: errorMessage(err) },
      'staff-login: Sicherheitsschlüssel-Anmeldung konnte nicht gestartet werden',
    );
    return { error: 'Sicherheitsschlüssel sind derzeit nicht verfügbar.' };
  }
}

export async function loginHardwareAction(input: {
  ceremonyId: string;
  response: AuthenticationResponseJSON;
  returnTo?: string;
}): Promise<{ error: string }> {
  if (
    typeof input?.ceremonyId !== 'string' ||
    input.ceremonyId.length > 128 ||
    !isAuthenticationResponse(input.response)
  ) {
    return { error: 'Die Antwort des Sicherheitsschlüssels ist ungültig.' };
  }
  const returnTo = safeStaffReturnTo(input.returnTo);
  try {
    await staffSignIn('hardware-key', {
      ceremonyId: input.ceremonyId,
      responseJson: JSON.stringify(input.response),
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Sicherheitsschlüssel ungültig oder für diesen Zugang nicht aktiviert.' };
    }
    throw error;
  }
  redirect(returnTo);
}

export async function loginAction(formData: FormData): Promise<LoginResult> {
  // Rate-Limit pro IP — 5 TOTP-Versuche / 5 Minuten. TOTP-Brute-Force ist
  // teuer (Replay-Schutz + Per-Token-One-Time-Use); pro Konto deckelt
  // checkStaffSecondFactorAccountLimit, ohne IP gilt zusätzlich nur die
  // Sturm-Obergrenze (S-03).
  const ip = getClientIp(await headers());
  if (!DEV_SKIP_TOTP) {
    const rl = await checkIpOrGlobalLimit('staff-totp', ip, { max: 5, windowSec: 300 });
    if (!rl.ok) {
      return {
        ok: false,
        error: `Zu viele Versuche. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
      };
    }
  }

  const returnTo = safeStaffReturnTo(formData.get('returnTo'));

  try {
    // R-04: Schritt 2 sendet nur das Einmal-Ticket aus dem Passwortschritt
    // und den Code — kein Passwort. Das Ticket ist danach verbraucht.
    await staffSignIn('credentials', {
      loginTicket: String(formData.get('loginTicket') ?? ''),
      totpCode: String(formData.get('totpCode') ?? ''),
      redirect: false,
    });
    if (!DEV_SKIP_TOTP && ip) {
      await resetRateLimit(`staff-totp:${ip}`);
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, error: 'Ungültige Anmeldedaten oder Code.' };
    }
    throw error;
  }

  // Cookie und Navigation in derselben Server-Action-Antwort abschließen.
  // Ein nachgelagertes window.location.href ließ Next zuvor nach der Cookie-
  // Mutation kurz den aktuellen RSC-Baum aktualisieren; dabei konnte die
  // globale Error-Boundary sichtbar werden, bevor der Hard-Reload begann.
  redirect(returnTo);
}
