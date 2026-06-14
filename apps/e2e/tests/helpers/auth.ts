// =============================================================================
// E2E-Helper: Login-Flow mit TOTP (und DEV_SKIP_TOTP-Support)
//
// Wenn DEV_SKIP_TOTP=true gesetzt ist, entfällt der TOTP-Schritt komplett —
// nach dem Passwort-Login landet man direkt auf dem Dashboard.
//
// Ohne DEV_SKIP_TOTP: Beim ersten Login erscheint der Setup-Schritt mit
// QR-Code. Wir extrahieren den Setup-Secret (sichtbar in <code>...</code>),
// generieren das TOTP und schließen das Enrollment ab. Bei späteren Logins
// reicht das gespeicherte Secret (in `process.env.E2E_TOTP_SECRET`).
// =============================================================================

import { type Page, expect } from '@playwright/test';
import { generateSync } from 'otplib';

export const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@taxtronik.local';
export const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? 'dev-password-123';

export async function loginAsAdmin(page: Page): Promise<void> {
  // networkidle wartet, bis alle async Scripts geladen sind und React
  // hydriert hat — load allein reicht bei Turbopack nicht.
  await page.goto('/staff/login', { waitUntil: 'networkidle' });

  // Schritt 1: Passwort
  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Weiter/ }).click();

  // DEV_SKIP_TOTP: Nach Passwort direkt auf Dashboard — checkPasswordAction
  // liefert devSkip:true, die UI triggert loginAction + window.location-Redirect.
  // Das sind zwei Server Actions, daher grosszügiger Timeout.
  const onDashboard = await page
    .waitForURL(/\/staff\/dashboard/, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (onDashboard) return;

  // Fallback: prüfen, ob auf der Staff-Login-Seite ein Fehler steht
  const errorText = await page.locator('[role="alert"], .text-red-600, .text-red-500').first().textContent().catch(() => '');
  if (errorText) {
    throw new Error(`Login fehlgeschlagen: ${errorText} (URL: ${page.url()})`);
  }

  // Wenn TOTP-Setup verlangt: Secret aus DOM lesen, durchklicken
  const setupVisible = await page
    .getByText(/Zwei-Faktor-Authentifizierung einrichten/i)
    .isVisible({ timeout: 2_000 })
    .catch(() => false);

  if (setupVisible) {
    const secret = await page.locator('code.text-sm').first().innerText();
    if (!secret) throw new Error('TOTP-Setup-Secret nicht im DOM gefunden.');
    process.env['E2E_TOTP_SECRET'] = secret.trim();

    await page.getByRole('button', { name: /QR-Code gescannt/ }).click();

    const code = generateSync({ secret: secret.trim() });
    await page.getByLabel('Bestätigungs-Code').fill(code);
    await page.getByRole('button', { name: /Bestätigen/ }).click();

    // Nach Enrollment erscheint eine Backup-Codes-Seite („Recovery-Codes").
    // Erst nach Bestätigung („Codes notiert") geht's zum TOTP-Login.
    const backupVisible = await page
      .getByText(/Recovery-Codes|Codes notiert/)
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    if (backupVisible) {
      await page.getByRole('button', { name: /Codes notiert/ }).click();
    }
  }

  // Schritt 2: TOTP-Login
  const secret = process.env['E2E_TOTP_SECRET'];
  if (!secret) {
    throw new Error(
      'TOTP-Secret unbekannt. Setze E2E_TOTP_SECRET=… oder lass den Admin im UI neu enrollen.',
    );
  }
  const code = generateSync({ secret });
  await page.getByLabel('TOTP-Code').fill(code);
  await page.getByRole('button', { name: /Anmelden/ }).click();

  await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 10_000 });
}
