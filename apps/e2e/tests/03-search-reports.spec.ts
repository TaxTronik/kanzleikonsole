import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

test.describe('Search + Reports', () => {
  test.skip(
    !process.env['E2E_TOTP_SECRET'] && !process.env['DEV_SKIP_TOTP'],
    'Setze E2E_TOTP_SECRET=… oder DEV_SKIP_TOTP=true damit dieser Test laufen kann.',
  );

  test('Globale Suche findet Test-Mandant', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByPlaceholder(/Mandanten, Anforderungen/i);
    await search.click();
    await search.fill('Mustermann');
    // Treffer im Dropdown sollte erscheinen
    await expect(page.getByRole('button').filter({ hasText: 'Mustermann GmbH' }).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Globale Suche findet Test-Anforderung', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByPlaceholder(/Mandanten, Anforderungen/i);
    await search.click();
    await search.fill('Belege Q3');
    await expect(page.getByText(/Belege Q3 2025/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Reports-Seite zeigt KPI-Kacheln', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/reports');
    await expect(page.getByRole('heading', { name: /Auswertungen/i })).toBeVisible();
    await expect(page.getByText(/Antwortrate/i)).toBeVisible();
    await expect(page.getByText(/Avg\. Antwortzeit/i)).toBeVisible();
    await expect(page.getByText(/Umsatz YTD/i)).toBeVisible();
  });

  test('Sidebar markiert aktiven Eintrag', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    // Mandanten-Link sollte als aktiv markiert sein (bg-brand-50 → text-brand-700)
    const mandantenLink = page.getByRole('link', { name: /Mandanten$/i }).first();
    await expect(mandantenLink).toHaveClass(/text-brand-700/);
  });
});
