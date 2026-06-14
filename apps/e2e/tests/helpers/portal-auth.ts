// =============================================================================
// E2E-Helper: Portal-Login via Magic-Link (MailHog)
// =============================================================================
import { type Page, expect } from '@playwright/test';

const MAILHOG_URL = process.env['E2E_MAILHOG_URL'] ?? 'http://localhost:8025';
const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

export const PORTAL_EMAIL = process.env['E2E_PORTAL_EMAIL'] ?? 'mandant@taxtronik.local';

export async function loginAsMandant(page: Page): Promise<void> {
  // Schritt 1: Magic-Link anfordern
  await page.goto('/portal/login', { waitUntil: 'networkidle' });
  await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
  await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
  await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 5000 });

  // Schritt 2: Magic-Link aus MailHog holen
  const link = await fetchMagicLink(PORTAL_EMAIL);
  if (!link) throw new Error('Magic-Link nicht in MailHog gefunden.');

  // Schritt 3: Link folgen → Login
  await page.goto(link, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/portal\/dashboard/, { timeout: 10_000 });
}

async function fetchMagicLink(email: string): Promise<string | null> {
  // MailHog API v2: Nachrichten abrufen
  const res = await fetch(`${MAILHOG_URL}/api/v2/messages?limit=5`);
  if (!res.ok) return null;
  const data = await res.json();
  const items: Array<{ Raw?: { From?: string; Data?: string }; Content?: { Headers?: Record<string, string[]>; Body?: string } }> = data.items ?? [];

  for (const msg of items.reverse()) {
    // MailHog v2: Content.Headers["To"] enthält Empfänger
    const raw = msg.Content?.Headers ?? msg.Raw ?? {};
    const to = Array.isArray(raw['To']) ? raw['To'].join(' ') : raw['To'] ?? '';
    if (!to.includes(email)) continue;

    const body = msg.Content?.Body ?? msg.Raw?.Data ?? '';
    // Magic-Link aus dem Mail-Body extrahieren
    const match = body.match(/https?:\/\/[^\s"'<>]+verify[^\s"'<>]*token=[^\s"'<>]+/);
    if (match) return match[0];
  }
  return null;
}
