import { type APIResponse, type Page, expect } from '@playwright/test';
import { generateSync } from 'otplib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function isStaffSessionCookieName(name: string): boolean {
  return STAFF_SESSION_COOKIE_RE.test(name);
}

type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
};

function describeStaffCookies(cookies: BrowserCookie[]): string {
  const staffCookies = cookies.filter((cookie) => isStaffSessionCookieName(cookie.name));
  if (staffCookies.length === 0) return '<none>';
  return staffCookies
    .map(
      (cookie) =>
        `${cookie.name}{domain=${cookie.domain};path=${cookie.path};secure=${cookie.secure};expires=${cookie.expires};valueLen=${cookie.value.length}}`,
    )
    .join(',');
}

function setCookieHeaderHasSecureAttribute(header: string): boolean {
  return /(?:^|;)\s*secure(?:;|$)/i.test(header);
}

function setCookieHeaders(response: APIResponse): string[] {
  const headers = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
  const collapsed = response.headers()['set-cookie'];
  if (collapsed && !headers.includes(collapsed)) headers.push(collapsed);
  return headers;
}

async function ensureStaffSessionCookieFromResponse(
  page: Page,
  response: APIResponse,
): Promise<boolean> {
  const existing = await page.context().cookies();
  if (existing.some((cookie) => isStaffSessionCookieName(cookie.name) && cookie.value.length > 0))
    return true;

  for (const header of setCookieHeaders(response)) {
    const match = header.match(/(__(?:Host-|Secure-)?taxtronik_staff_session)=([^;,]+)/);
    if (!match) continue;
    const cookieName = match[1]!;
    await page.context().addCookies([
      {
        name: cookieName,
        value: match[2]!,
        url: new URL('/', page.url()).toString(),
        httpOnly: true,
        secure:
          setCookieHeaderHasSecureAttribute(header) ||
          cookieName.startsWith('__Host-') ||
          cookieName.startsWith('__Secure-'),
        sameSite: 'Lax',
      },
    ]);
    return true;
  }
  return false;
}

async function assertDashboardAcceptsStaffSession(page: Page): Promise<void> {
  const response = await page.context().request.get(STAFF_DASHBOARD_PATH, { maxRedirects: 0 });
  const status = response.status();
  if (status >= 200 && status < 300) return;

  const location = response.headers()['location'] ?? '';
  const body = await response.text().catch(() => '');
  const cookies = await page.context().cookies();

  throw new Error(
    `DEV_SKIP_TOTP-Session wurde vom Dashboard abgelehnt: status=${status} url=${response.url()} ` +
      `location=${location} staffCookies=${describeStaffCookies(cookies)} ` +
      `body=${body.slice(0, 300)}`,
  );
}

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/staff/login', { waitUntil: 'networkidle' });

  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort').fill(ADMIN_PASSWORD);

  // CI uses DEV_SKIP_TOTP. Exercise the real browser submit first; if React or
  // Server Actions hang, fall back to the deterministic POST route and verify
  // that the session cookie is really present before opening the dashboard.
  if (process.env['DEV_SKIP_TOTP'] === 'true') {
    const continueButton = page.getByRole('button', { name: /Weiter|Wird gepr/i });
    await expect(continueButton).toBeEnabled({ timeout: 10_000 });
    await continueButton.click();

    const uiReachedDashboard = await page
      .waitForURL(/\/staff\/dashboard/, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (uiReachedDashboard) {
      await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 5_000 });
      return;
    }

    const response = await page
      .context()
      .request.post('/staff/login/password?returnTo=%2Fstaff%2Fdashboard', {
        form: {
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          tenantSlug: 'default',
        },
        maxRedirects: 0,
      });
    const location = response.headers()['location'] ?? '';
    const hasSessionCookie = await ensureStaffSessionCookieFromResponse(page, response);
    if (response.status() !== 303 || !/\/staff\/dashboard$/.test(location) || !hasSessionCookie) {
      const body = await response.text().catch(() => '');
      const cookies = await page.context().cookies();
      throw new Error(
        `DEV_SKIP_TOTP-Login-Fallback fehlgeschlagen: status=${response.status()} location=${location} ` +
          `hasSessionCookie=${hasSessionCookie} cookies=${cookies.map((c) => c.name).join(',')} body=${body.slice(0, 500)}`,
      );
    }

    await assertDashboardAcceptsStaffSession(page);
    await page.goto(STAFF_DASHBOARD_PATH, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });
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

  const stillOnPasswordStep = await page
    .getByRole('button', { name: /^Weiter$/ })
    .isVisible({ timeout: 1000 })
    .catch(() => false);
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

    const backupVisible = await page
      .getByText(/Recovery-Codes|Codes notiert/)
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
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
