// =============================================================================
// E2E-Helper: Portal-Login via Magic-Link (MailHog)
// =============================================================================
import { type Page, type APIRequestContext, expect } from '@playwright/test';
import { flushRedisDb } from './redis';

const MAILHOG_URL = process.env['E2E_MAILHOG_URL'] ?? 'http://127.0.0.1:8025';
const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

export const PORTAL_EMAIL = process.env['E2E_PORTAL_EMAIL'] ?? 'mandant@taxtronik.local';

export async function loginAsMandant(page: Page, request: APIRequestContext): Promise<void> {
  await flushRedisDb();
  // Alte Mails vor dem Request entfernen, damit wir sicher den neuen Token
  // greifen. Nicht in fetchMagicLink löschen: dort wäre die Mail schon erzeugt.
  await clearMailhogMessages(request);

  // Schritt 1: Magic-Link anfordern
  await page.goto('/portal/login', { waitUntil: 'networkidle' });
  await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
  await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
  await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 5000 });

  // Schritt 2: Magic-Link aus MailHog holen (via APIRequestContext)
  const link = await fetchMagicLink(request, PORTAL_EMAIL);
  if (!link) throw new Error('Magic-Link nicht in MailHog gefunden.');

  // Schritt 3: Link folgen -> Login
  const normalizedLink = new URL(link);
  const base = new URL(BASE_URL);
  normalizedLink.protocol = base.protocol;
  normalizedLink.host = base.host;
  await page.goto(normalizedLink.toString(), { waitUntil: 'domcontentloaded' });
  // Seit 666c7ab zeigt die Verify-Seite pro Mandantenprofil einen Button
  // ("{Mandant} / Als {Kontakt} öffnen") statt eines einzelnen "Anmelden".
  await page
    .getByRole('button', { name: /öffnen/i })
    .first()
    .click();
  // Wait for redirect to dashboard (may take a moment with Turbopack)
  await page.waitForURL(/\/portal\/dashboard/, { timeout: 15_000 }).catch(() => {});
  await expectPortalDashboardReady(page);
}

export async function expectPortalDashboardReady(page: Page, timeout = 20_000): Promise<void> {
  await expect(page).toHaveURL(/\/portal\/dashboard/, { timeout });
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

  const dashboardShell = page
    .getByRole('heading', { name: /Hallo/i })
    .or(page.getByText(/Ubersicht|Übersicht/i))
    .first();

  try {
    await expect(
      dashboardShell,
      'Portal-Dashboard muss nach Magic-Link-Login gerendert sein',
    ).toBeVisible({ timeout });
    await expect(page.getByRole('link', { name: /Dokumente/i })).toBeVisible({ timeout: 10_000 });
  } catch (e) {
    const body = await page
      .locator('body')
      .innerText({ timeout: 1000 })
      .catch(() => '');
    throw new Error(
      `Portal-Dashboard wurde nicht fertig gerendert. url=${page.url()} body=${body.replace(/\s+/g, ' ').slice(0, 800)} cause=${(e as Error).message}`,
      { cause: e },
    );
  }
}

export async function clearMailhogMessages(request: APIRequestContext): Promise<void> {
  try {
    await request.delete(`${MAILHOG_URL}/api/v1/messages`);
  } catch {
    // best-effort: einzelne Tests prüfen MailHog-Erreichbarkeit explizit
  }
}

async function fetchMagicLink(request: APIRequestContext, email: string): Promise<string | null> {
  const res = await request.get(`${MAILHOG_URL}/api/v2/messages?limit=5`);
  if (!res.ok()) return null;
  const data = await res.json();
  const items: Array<{
    Content?: { Headers?: Record<string, string[]>; Body?: string };
    MIME?: { Parts?: Array<{ Body?: string }> };
  }> = data.items ?? [];

  // Sort by newest first using item index (higher index = newer in reversed array)
  for (const msg of items) {
    const headers = msg.Content?.Headers ?? {};
    const to = Array.isArray(headers['To']) ? headers['To'].join(' ') : (headers['To'] ?? '');
    if (!to.includes(email)) continue;

    const bodies = [msg.Content?.Body, ...(msg.MIME?.Parts ?? []).map((p) => p.Body)].filter(
      Boolean,
    ) as string[];
    for (let body of bodies) {
      // Remove soft line breaks (quoted-printable = at end of line)
      body = body.replace(/=\r?\n/g, '');
      // Decode =3D -> = (quoted-printable equals sign)
      body = body.replace(/=3D/g, '=');
      // Strip zero-width characters (U+E0085 = EE 80 85 in UTF-8 / quoted-printable)
      body = body.replace(/=EE=80=85/g, '');
      // Some text parts escape underscores as \_; tokens are base64url and use
      // literal underscores, not backslash-escaped ones.
      body = body.replace(/\\_/g, '_');

      const match = body.match(/https?:\/\/[^\s"'<>]+verify[^\s"'<>]*token=[A-Za-z0-9_-]+/);
      if (match) return match[0];
    }
  }
  return null;
}

/** Nur Magic-Link anfordern, kein Login (für negative Tests) */
export async function requestMagicLink(page: Page): Promise<void> {
  await flushRedisDb();
  await page.goto('/portal/login', { waitUntil: 'networkidle' });
  await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
  await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
  await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 5000 });
}
