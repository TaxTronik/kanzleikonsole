import { type Page, expect } from '@playwright/test';
import { generateSync } from 'otplib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gotoReady } from './page-ready';
import { becomesVisible } from './visibility';

function readLocalSeedCredentials(): { email?: string; password?: string } {
  try {
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../packages/db/.admin-credentials.txt',
    );
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return { email: values['email'], password: values['password'] };
  } catch {
    return {};
  }
}

// Der Dev-Seed erzeugt standardmäßig ein zufälliges Passwort. Lokale
// Browserläufe dürfen dessen gitignored Credential-Datei verwenden, ohne den
// Wert auszugeben; explizite E2E-Variablen (insbesondere CI) haben Vorrang.
const localSeedCredentials = readLocalSeedCredentials();
export const ADMIN_EMAIL =
  process.env['E2E_ADMIN_EMAIL'] ?? localSeedCredentials.email ?? 'admin@taxtronik.local';
export const ADMIN_PASSWORD =
  process.env['E2E_ADMIN_PASSWORD'] ?? localSeedCredentials.password ?? 'dev-password-123';

const STAFF_SESSION_COOKIE_RE = /^__(?:Host-|Secure-)?taxtronik_staff_session$/;
const STAFF_DASHBOARD_PATH = '/staff/dashboard';

/**
 * Öffnet die Staff-Anmeldung eingabebereit. Nach der Hydration fragt die Seite
 * per Server Action, ob Sicherheitsschlüssel eingerichtet sind, und blendet
 * dann einen weiteren Anmeldeweg über dem Passwortformular ein. Auf genau diese
 * Antwort und ihr Ergebnis warten: Formular, Axe und Layoutmessungen sehen so
 * den endgültigen Zustand.
 */
export async function openStaffLogin(page: Page): Promise<void> {
  const [availability] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/staff/login' &&
        'next-action' in response.request().headers(),
    ),
    gotoReady(page, '/staff/login', page.getByRole('button', { name: 'Weiter', exact: true })),
  ]);
  // Ende und Body eines vom Browser gestreamten RSC-Abrufs meldet Playwright
  // nicht zuverlässig (dieselbe Ursache wie bei networkidle). Die lesende
  // Action deshalb mit derselben Anfrage erneut stellen und am DOM prüfen,
  // dass die Seite ihr Ergebnis anzeigt; die Seite selbst bleibt unbeeinflusst.
  const replay = await page.request.fetch(availability.request());
  expect(replay.ok(), 'Abfrage der Sicherheitsschlüssel muss antworten').toBe(true);
  const hardwareLogin = page.getByRole('button', { name: 'Mit Sicherheitsschlüssel anmelden' });
  if (/"available":true\b/.test(await replay.text())) {
    await expect(hardwareLogin).toBeVisible();
  } else {
    await expect(hardwareLogin).toHaveCount(0);
  }
}

export async function loginAsAdmin(page: Page): Promise<void> {
  await openStaffLogin(page);

  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort').fill(ADMIN_PASSWORD);

  if (process.env['DEV_SKIP_TOTP'] === 'true') {
    const submit = page.getByRole('button', { name: /^Weiter$/ });
    // Der Passwortschritt und die Ticket-Einlösung sind zwei Server-Actions.
    // Auch bei langsamer Rückmeldung bleibt dies ein einziger Anmeldeversuch.
    await Promise.all([
      page.waitForURL((url) => url.pathname === STAFF_DASHBOARD_PATH, { waitUntil: 'commit' }),
      submit.click(),
    ]);
    await expect(page.locator('#main-content')).toBeVisible();
    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => STAFF_SESSION_COOKIE_RE.test(cookie.name))).toBe(true);
    return;
  }

  const continueButton = page.getByRole('button', { name: /Weiter|Wird gepr/i });
  await expect(continueButton).toBeEnabled({ timeout: 10_000 });
  await continueButton.click();

  let onDashboard = await page
    .waitForURL(/\/staff\/dashboard/, { timeout: 7_000 })
    .then(() => true)
    .catch(() => false);
  if (onDashboard) return;

  // Die Login-Schritte sind Zustände ohne gemeinsamen Anker (Passwortschritt,
  // Fehler, TOTP-Einrichtung, TOTP-Abfrage): jeweils kurz auf den Schritt warten.
  const stillOnPasswordStep = await becomesVisible(
    page.getByRole('button', { name: /^Weiter$/ }),
    1000,
  );
  if (stillOnPasswordStep) {
    const retryButton = page.getByRole('button', { name: /^Weiter$/ });
    await expect(retryButton).toBeEnabled({ timeout: 10_000 });
    await retryButton.click();
    onDashboard = await page
      .waitForURL(/\/staff\/dashboard/, { timeout: 7_000 })
      .then(() => true)
      .catch(() => false);
    if (onDashboard) return;
  }

  const errorText = await page
    .locator(
      '[role="alert"], .alert-error-sm, .alert-error, .text-red-600, .text-red-500, .text-red-700',
    )
    .first()
    .textContent()
    .catch(() => '');
  if (errorText) {
    throw new Error(`Login fehlgeschlagen: ${errorText} (URL: ${page.url()})`);
  }

  const setupVisible = await becomesVisible(
    page.getByText(/Zwei-Faktor-Authentifizierung einrichten/i),
    2_000,
  );

  if (setupVisible) {
    const secret = await page.locator('code.text-sm').first().innerText();
    if (!secret) throw new Error('TOTP-Setup-Secret nicht im DOM gefunden.');
    process.env['E2E_TOTP_SECRET'] = secret.trim();

    await page.getByRole('button', { name: /QR-Code gescannt/ }).click();

    const code = generateSync({ secret: secret.trim() });
    await page.getByLabel('Bestätigungs-Code').fill(code);
    await page.getByRole('button', { name: /Bestätigen/ }).click();

    const backupVisible = await becomesVisible(
      page.getByText(/Recovery-Codes|Codes notiert/),
      3_000,
    );
    if (backupVisible) {
      await page.getByRole('button', { name: /Codes notiert/ }).click();
    }
  }

  const secret = process.env['E2E_TOTP_SECRET'];
  if (!secret) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    if (
      /Mitarbeiter-Login/i.test(bodyText) &&
      /Passwort/i.test(bodyText) &&
      /Weiter/i.test(bodyText)
    ) {
      throw new Error(
        `Passwort-Login blieb auf Schritt 1 stehen. DEV_SKIP_TOTP/Passwort/Server-Action pruefen. URL: ${page.url()}. Text: ${bodyText.slice(0, 500)}`,
      );
    }
    throw new Error(
      'TOTP-Secret unbekannt. Setze E2E_TOTP_SECRET oder lass den Admin im UI neu enrollen.',
    );
  }

  const code = generateSync({ secret });
  await page.getByLabel('TOTP-Code').fill(code);
  await page.getByRole('button', { name: /Anmelden/ }).click();

  await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 10_000 });
}
