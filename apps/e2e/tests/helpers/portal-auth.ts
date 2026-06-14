// =============================================================================
// E2E-Helper: Portal-Login via Magic-Link (MailHog)
// =============================================================================
import { type Page, type APIRequestContext, expect } from '@playwright/test';

const MAILHOG_URL = process.env['E2E_MAILHOG_URL'] ?? 'http://127.0.0.1:8025';

export const PORTAL_EMAIL = process.env['E2E_PORTAL_EMAIL'] ?? 'mandant@taxtronik.local';

export async function loginAsMandant(page: Page, request: APIRequestContext): Promise<void> {
  // Schritt 1: Magic-Link anfordern
  await page.goto('/portal/login', { waitUntil: 'networkidle' });
  await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
  await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
  await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 5000 });

  // Schritt 2: Magic-Link aus MailHog holen (via APIRequestContext)
  const link = await fetchMagicLink(request, PORTAL_EMAIL);
  if (!link) throw new Error('Magic-Link nicht in MailHog gefunden.');

  // Schritt 3: Link folgen -> Login
  await page.goto(link);
  await page.waitForTimeout(3000);
  // Wait for redirect to dashboard (may take a moment with Turbopack)
  await page.waitForURL(/\/portal\/dashboard/, { timeout: 15_000 }).catch(() => {});
  await expect(page).toHaveURL(/\/portal\/dashboard/, { timeout: 5_000 });
}

async function fetchMagicLink(request: APIRequestContext, email: string): Promise<string | null> {
  // Delete all previous messages to avoid stale tokens
  try {
    await request.delete(`${MAILHOG_URL}/api/v1/messages`);
  } catch { /* best-effort */ }

  const res = await request.get(`${MAILHOG_URL}/api/v2/messages?limit=5`);
  if (!res.ok()) return null;
  const data = await res.json();
  const items: Array<{ Content?: { Headers?: Record<string, string[]>; Body?: string } }> = data.items ?? [];

  // Sort by newest first using item index (higher index = newer in reversed array)
  for (const msg of items) {
    const headers = msg.Content?.Headers ?? {};
    const to = Array.isArray(headers['To']) ? headers['To'].join(' ') : headers['To'] ?? '';
    if (!to.includes(email)) continue;

    let body = msg.Content?.Body ?? '';
    // Remove soft line breaks (quoted-printable = at end of line)
    body = body.replace(/=\r?\n/g, '');
    // Decode =3D -> = (quoted-printable equals sign)
    body = body.replace(/=3D/g, '=');
    // Strip zero-width characters (U+E0085 = EE 80 85 in UTF-8 / quoted-printable)
    body = body.replace(/=EE=80=85/g, '');

    const match = body.match(/https?:\/\/[^\s"'<>]+verify[^\s"'<>]*token=[^\s"'<>]+/);
    if (match) return match[0];
  }
  return null;
}

/** Nur Magic-Link anfordern, kein Login (für negative Tests) */
export async function requestMagicLink(page: Page): Promise<void> {
  await page.goto('/portal/login', { waitUntil: 'networkidle' });
  await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
  await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
  await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 5000 });
}
