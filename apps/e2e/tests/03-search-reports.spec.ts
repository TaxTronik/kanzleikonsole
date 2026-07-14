import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

test.describe('Search + Reports', () => {
  test('Globale Suche findet Test-Mandant', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByPlaceholder(/Mandanten, Anforderungen/i);
    await search.click();
    await search.fill('Mustermann');
    // Treffer im Dropdown sollte erscheinen
    await expect(
      page.getByRole('button').filter({ hasText: 'Mustermann GmbH' }).first(),
    ).toBeVisible({ timeout: 5_000 });
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
    // Demo-Seed enthält nicht zwingend alle KPIs — prüfe nur, dass
    // mindestens eine KPI-Kachel vorhanden ist.
    const kpi = page
      .locator('text=/Antwortrate|Avg\\. Antwortzeit|Umsatz YTD|Ø Bearbeitungszeit/i')
      .first();
    await expect(kpi).toBeVisible();
  });

  test('Sidebar markiert aktiven Eintrag', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    // Mandanten-Link sollte als aktiv markiert sein (bg-brand-50 → text-brand-700)
    const mandantenLink = page.getByRole('link', { name: /Mandanten$/i }).first();
    await expect(mandantenLink).toHaveClass(/text-brand-700/);
  });
});
