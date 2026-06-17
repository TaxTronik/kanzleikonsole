'use server';

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
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
import { recordFailedLoginAudited } from '@/server/auth/login-audit';
import { evidenceService } from '@/server/container';
import { prismaOwner } from '@/server/db/prisma-owner';
import {
  checkIpOrGlobalLimit,
  checkStaffPasswordAccountLimit,
  getClientIp,
  resetRateLimit,
  staffPasswordAccountRateLimitKey,
} from '@/server/rate-limit';
import { env } from '@taxtronik/config';

const { compare, hash } = bcrypt;

// Crockford-Base32 ohne verwechselbare Glyphen (kein I/L/O/U).
// 32 Zeichen → 5 Bit pro Zeichen. 10 Zeichen = 50 Bit Entropie pro Backup-Code.
const BACKUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const BACKUP_CODE_LENGTH = 10;

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

  // Rate-Limit pro IP — 10 Versuche / 10 Minuten. Per-IP wenn bekannt,
  // sonst globaler Sturm-Bucket (H-2/N-3).
  const ip = getClientIp(await headers());
  const rl = await checkIpOrGlobalLimit(
    'staff-pw',
    ip,
    { max: 10, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Versuche. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  const tenant = await prismaOwner.tenant.findFirst({ where: { slug: tenantSlug } });
  if (!tenant) {
    return { ok: false, error: 'Kanzlei nicht gefunden.' };
  }

  const staffUser = await prismaOwner.staffUser.findFirst({
    where: { tenantId: tenant.id, email: email.toLowerCase() },
  });

  // Absichtlich keine Unterscheidung zwischen "User nicht gefunden" und "Passwort falsch"
  if (!staffUser || !staffUser.active) {
    return { ok: false, error: 'Ungültige Anmeldedaten.' };
    // Hinweis: GENERIC_LOGIN_ERROR ist hier noch nicht im Scope — der String
    // ist identisch.
  }

  // M2: Anti-Enumeration. Vorher unterschied der Code "Konto gesperrt" von
  // "Ungültige Anmeldedaten" — ein Angreifer konnte daran existierende
  // Accounts erkennen (nach 5 Versuchen Lockout-Meldung). Jetzt einheitlich,
  // mit dezentem Hinweis zur Wartezeit ohne preisgeben, dass der Account
  // existiert/gesperrt ist.
  const GENERIC_LOGIN_ERROR = 'Ungültige Anmeldedaten.';

  if (staffUser.lockedUntil && staffUser.lockedUntil > new Date()) {
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  const accountRl = await checkStaffPasswordAccountLimit(staffUser.id);
  if (!accountRl.ok) {
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  const passwordOk = await compare(password, staffUser.passwordHash);
  if (!passwordOk) {
    // Account-gebundener Lockout (S2 + L-4): Lockout greift erst bei N _distinkten_
    // Quell-IPs in einem rollierenden Fenster. Single-IP-Spam fängt das IP-RL ab,
    // ohne den Account zu sperren — kein Lockout-DoS via bekannte E-Mail.
    // RF-12: zählt UND schreibt auth.login.failure(/.lockout) in die Audit-Chain.
    await recordFailedLoginAudited({
      tenantId: tenant.id,
      staffUserId: staffUser.id,
      email: staffUser.email,
      ip,
      reason: 'password',
    }).catch(() => void 0);
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  // Erfolg → Counter zurücksetzen (IP-RL + Account-Counter)
  await resetRateLimit(ip ? `staff-pw:${ip}` : 'staff-pw:global');
  await resetRateLimit(staffPasswordAccountRateLimitKey(staffUser.id));
  resetFailedLogin(prismaOwner, staffUser.id).catch(() => void 0);

  // DEV-ONLY: TOTP überspringen → UI loggt direkt ein (ohne Code/Setup).
  if (DEV_SKIP_TOTP) {
    return { ok: true, devSkip: true };
  }

  // TOTP bereits eingerichtet?
  if (staffUser.totpEnrolledAt && staffUser.totpSecretEnc) {
    return { ok: true, totpRequired: true };
  }

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
  const SETUP_TTL_MS = 60 * 60 * 1000;
  if (
    staffUser.totpSecretEnc &&
    staffUser.totpSetupStartedAt &&
    Date.now() - staffUser.totpSetupStartedAt.getTime() > SETUP_TTL_MS
  ) {
    return {
      ok: false,
      error:
        'TOTP-Setup-Fenster abgelaufen. Bitte ADMIN/PARTNER kontaktieren, um den Account neu zu provisionieren.',
    };
  }

  const authSecret = env.AUTH_SECRET;
  let rawSecret: string;
  if (staffUser.totpSecretEnc) {
    rawSecret = decryptTotpSecret(staffUser.totpSecretEnc, tenant.id, authSecret);
  } else {
    rawSecret = generateTotpSecret();
    const encSecret = encryptTotpSecret(rawSecret, tenant.id, authSecret);
    await prismaOwner.staffUser.update({
      where: { id: staffUser.id },
      data: {
        totpSecretEnc: encSecret,
        totpEnrolledAt: null,
        totpSetupStartedAt: new Date(),
      },
    });
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
}

export async function confirmTotpEnrollmentAction(
  email: string,
  password: string,
  totpCode: string,
  tenantSlug: string = 'default',
): Promise<ConfirmEnrollmentResult> {
  const tenant = await prismaOwner.tenant.findFirst({ where: { slug: tenantSlug } });
  if (!tenant) return { ok: false, error: 'Kanzlei nicht gefunden.' };

  const staffUser = await prismaOwner.staffUser.findFirst({
    where: { tenantId: tenant.id, email: email.toLowerCase() },
  });
  if (!staffUser || !staffUser.active) return { ok: false, error: 'Ungültige Daten.' };

  const passwordOk = await compare(password, staffUser.passwordHash);
  if (!passwordOk) return { ok: false, error: 'Ungültige Daten.' };

  if (!staffUser.totpSecretEnc) return { ok: false, error: 'Kein TOTP-Secret gefunden.' };

  const authSecret = env.AUTH_SECRET;
  const { decryptTotpSecret } = await import('@/server/auth/totp');
  const rawSecret = decryptTotpSecret(staffUser.totpSecretEnc, tenant.id, authSecret);

  if (!verifyTotpCode(totpCode, rawSecret)) {
    return { ok: false, error: 'Ungültiger Bestätigungs-Code. Bitte erneut versuchen.' };
  }

  // Backup-Codes generieren (8 Codes à 10 Zeichen, ~50 Bit Entropie pro Code).
  // crypto.randomBytes — Math.random() ist nicht kryptographisch sicher und
  // Backup-Codes umgehen TOTP komplett, müssen also mindestens so stark sein
  // wie das TOTP-Secret.
  const backupCodes = Array.from({ length: 8 }, generateBackupCode);
  const hashedBackupCodes = await Promise.all(backupCodes.map((c) => hash(c, 12)));

  // RF-12: das TOTP-Enrollment ist die Wurzel der 2FA-Vertrauenskette → in
  // DERSELBEN Tx wie die Mutation in die Audit-Hash-Chain (auth.totp.enroll).
  await prismaOwner.$transaction(async (tx) => {
    await tx.staffUser.update({
      where: { id: staffUser.id },
      data: {
        totpEnrolledAt: new Date(),
        totpBackupCodes: hashedBackupCodes,
      },
    });
    await evidenceService.record(tx, {
      tenantId: tenant.id,
      actorType: 'STAFF',
      actorId: staffUser.id,
      action: 'auth.totp.enroll',
      resourceType: 'staff_user',
      resourceId: staffUser.id,
      after: { email: staffUser.email, backupCodesIssued: backupCodes.length },
    });
  });

  // V-1: Rohe Codes EINMAL an den Client zurück. Vorher waren sie tot in der
  // DB — User wussten nichts davon, Phone-Verlust = dauerhaft ausgesperrt,
  // Admin musste neu provisionieren. Jetzt ist Recovery-Pfad funktional.
  return { ok: true, backupCodes };
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export async function loginAction(formData: FormData): Promise<LoginResult> {
  // Rate-Limit pro IP — 5 TOTP-Versuche / 5 Minuten. TOTP-Brute-Force ist
  // teuer (Replay-Schutz + Per-Token-One-Time-Use), bei null-IP weiter
  // globaler Sturm-Bucket.
  const ip = getClientIp(await headers());
  if (!DEV_SKIP_TOTP) {
    const rl = await checkIpOrGlobalLimit(
      'staff-totp',
      ip,
      { max: 5, windowSec: 300 },
      { max: 100, windowSec: 300 },
    );
    if (!rl.ok) {
      return {
        ok: false,
        error: `Zu viele Versuche. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
      };
    }
  }

  try {
    await staffSignIn('credentials', {
      email: formData.get('email') as string,
      password: formData.get('password') as string,
      totpCode: formData.get('totpCode') as string,
      tenantSlug: (formData.get('tenantSlug') as string) || 'default',
      redirect: false,
    });
    // Cookie wurde durch staffSignIn in der Response gesetzt.
    // Client macht jetzt window.location.href = '/staff/dashboard'
    // (Hard-Reload, damit Browser den Cookie zuverlässig im nächsten Request mitsendet).
    if (!DEV_SKIP_TOTP) {
      await resetRateLimit(ip ? `staff-totp:${ip}` : 'staff-totp:global');
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, error: 'Ungültige Anmeldedaten oder Code.' };
    }
    throw error;
  }
}
