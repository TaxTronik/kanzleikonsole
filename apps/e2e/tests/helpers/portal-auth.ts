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
  await page.goto(link, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/portal\/dashboard/, { timeout: 10_000 });
}

async function fetchMagicLink(request: APIRequestContext, email: string): Promise<string | null> {
  const res = await request.get(`${MAILHOG_URL}/api/v2/messages?limit=5`);
  if (!res.ok()) return null;
  const data = await res.json();
  const items: Array<{ Content?: { Headers?: Record<string, string[]>; Body?: string } }> = data.items ?? [];

  for (const msg of items.reverse()) {
    const headers = msg.Content?.Headers ?? {};
    const to = Array.isArray(headers['To']) ? headers['To'].join(' ') : headers['To'] ?? '';
    if (!to.includes(email)) continue;

    const body = msg.Content?.Body ?? '';
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
