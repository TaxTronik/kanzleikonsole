// =============================================================================
// E2E-Helper: Login-Flow mit TOTP
//
// Wenn der Admin-User noch nie eingeloggt war (totpEnrolledAt=null),
// erscheint der Setup-Schritt mit QR-Code. Wir extrahieren den Setup-Secret
// aus der Seite (sichtbar in <code>...</code>), generieren das TOTP und
// schließen das Enrollment ab. Bei späteren Logins reicht das gespeicherte
// Secret (in `process.env.E2E_TOTP_SECRET`).
// =============================================================================

import { type Page, expect } from '@playwright/test';
import { authenticator } from 'otplib';

export const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@taxtronik.local';
export const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? 'dev-password-123';

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/staff/login');

  // Schritt 1: Passwort
  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Weiter/ }).click();

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

    const code = authenticator.generate(secret.trim());
    await page.getByLabel('Bestätigungs-Code').fill(code);
    await page.getByRole('button', { name: /Bestätigen/ }).click();
  }

  // Schritt 2: TOTP-Login
  const secret = process.env['E2E_TOTP_SECRET'];
  if (!secret) {
    throw new Error(
      'TOTP-Secret unbekannt. Setze E2E_TOTP_SECRET=… oder lass den Admin im UI neu enrollen.',
    );
  }
  const code = authenticator.generate(secret);
  await page.getByLabel('TOTP-Code').fill(code);
  await page.getByRole('button', { name: /Anmelden/ }).click();

  await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 10_000 });
}
