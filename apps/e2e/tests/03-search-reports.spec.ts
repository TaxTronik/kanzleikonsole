import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

test.describe('Search + Reports', () => {
  test('Globale Suche findet Test-Mandant', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByRole('combobox', { name: 'Globale Suche' });
    await search.click();
    await search.fill('Mustermann');
    const clientResult = page
      .getByRole('listbox', { name: 'Suchergebnisse' })
      .getByRole('option', { name: /^Mustermann GmbH(?:\s|$)/ });
    await expect(clientResult).toBeVisible({ timeout: 5_000 });
    await clientResult.click();
    await expect(page).toHaveURL(/\/staff\/clients\/[0-9a-f-]+$/i);
    await expect(page.getByRole('heading', { name: 'Mustermann GmbH', exact: true })).toBeVisible();
  });

  test('Globale Suche findet Test-Anforderung', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByRole('combobox', { name: 'Globale Suche' });
    await search.click();
    await search.fill('Belege Q3');
    await expect(
      page
        .getByRole('listbox', { name: 'Suchergebnisse' })
        .getByRole('option', { name: /^Belege Q3 2025(?:\s|$)/i }),
    ).toBeVisible({ timeout: 5_000 });
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
    const navigation = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const mandantenLink = navigation.getByRole('link', { name: 'Mandanten', exact: true });
    const dashboardLink = navigation.getByRole('link', { name: 'Dashboard', exact: true });
    await expect(mandantenLink).toHaveAttribute('aria-current', 'page');
    await expect(mandantenLink).toHaveClass(/(?:^|\s)active(?:\s|$)/);
    await expect(navigation.locator('a[aria-current="page"]')).toHaveCount(1);

    await dashboardLink.click();
    await expect(page).toHaveURL(/\/staff\/dashboard$/);
    await expect(dashboardLink).toHaveAttribute('aria-current', 'page');
    await expect(mandantenLink).not.toHaveAttribute('aria-current', 'page');
    await expect(mandantenLink).not.toHaveClass(/(?:^|\s)active(?:\s|$)/);
    await expect(navigation.locator('a[aria-current="page"]')).toHaveCount(1);
  });
});
