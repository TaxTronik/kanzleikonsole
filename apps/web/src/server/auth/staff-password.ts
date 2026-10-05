// =============================================================================
// Passwortprüfung der Staff-Anmeldung (S-09)
//
// Jeder Passwortversuch kostet genau einen bcrypt-Vergleich — auch bei
// unbekannter Kanzlei, unbekanntem, deaktiviertem, gesperrtem oder
// Hardware-only-Konto. Dann wird gegen einen festen Dummy-Hash derselben
// Kosten verglichen, und alle diese Fälle liefern dieselbe Meldung wie ein
// falsches Passwort. Vorher kehrten sie vor bcrypt zurück: Antwortzeit (und
// bei unbekannter Kanzlei der Text) verrieten gültige E-Mail-Adressen.
//
// Bewusst unverändert (S-03): Ist das Passwortkontingent eines existierenden
// Kontos erschöpft, wird ohne Hashvergleich abgewiesen (kein Passworttest und
// keine bcrypt-Last über das Kontingent hinaus).
//
// Der Vergleich läuft nicht im Haupt-Thread, sondern im begrenzten
// Worker-Thread-Pool (password-hash-pool.ts); Hashformat und Kosten bleiben.
// =============================================================================

import { comparePasswordHash } from './password-hash-pool';

/** Kosten aller Staff-Passwort-Hashes (Anlage, Änderung, Reset, Seeds). */
export const STAFF_PASSWORD_HASH_COST = 12;

/**
 * bcrypt-Hash (Kosten 12) eines verworfenen 256-Bit-Zufallswerts. Er dient nur
 * dazu, für nicht zulässige Konten dieselbe Rechenzeit aufzuwenden.
 */
export const DUMMY_PASSWORD_HASH = '$2b$12$YqNAPis4moX.IRJiLSJlRO1PZtpLTI8WKhBeRBeD.xplBL1EUvNwO';

interface PasswordLoginState {
  active: boolean;
  hardwareOnlyEnabledAt: Date | null;
  lockedUntil: Date | null;
}

/**
 * Hardware-only ist eine serverseitige Kontoeigenschaft; weder Passwort noch
 * TOTP, Backup-Code oder DEV_SKIP_TOTP sind dann ein Fallback. Eine aktive
 * Sperre läuft regulär aus.
 */
export function passwordAuthenticationBlocked(
  account: Pick<PasswordLoginState, 'hardwareOnlyEnabledAt' | 'lockedUntil'>,
): boolean {
  return (
    Boolean(account.hardwareOnlyEnabledAt) ||
    Boolean(account.lockedUntil && account.lockedUntil > new Date())
  );
}

/** Das Konto, wenn es sich per Passwort anmelden darf, sonst null. */
export function passwordLoginAccount<T extends PasswordLoginState>(account: T | null): T | null {
  return account && account.active && !passwordAuthenticationBlocked(account) ? account : null;
}

/**
 * Genau ein bcrypt-Vergleich: gegen den Hash des zulässigen Kontos oder, ohne
 * ein solches, gegen DUMMY_PASSWORD_HASH. true nur für ein zulässiges Konto
 * mit passendem Passwort. Ist der Pool ausgelastet oder gestört, wirft er
 * PasswordHashPoolSaturatedError bzw. PasswordHashPoolUnavailableError, ohne
 * verglichen zu haben.
 */
export async function verifyStaffPassword(
  password: string,
  account: { passwordHash: string } | null,
): Promise<boolean> {
  const matches = await comparePasswordHash(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  return account !== null && matches;
}
