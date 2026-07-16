import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

test.describe('Auth-Flow', () => {
  test('Admin loggt sich ein und sieht Dashboard', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible();
  });

  test('Admin sieht Mandanten-Liste mit Test-Mandant', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible();
  });

  test('Admin sieht Admin-Sidebar (Datenschutz + Einstellungen)', async ({ page }) => {
    await loginAsAdmin(page);
    // Sidebar-Label seit 666c7ab: "Datenschutz" (bündelt /staff/admin/privacy,
    // dsgvo, dsgvo-retention, service-providers) statt "DSGVO".
    await expect(page.getByRole('link', { name: /Datenschutz/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Einstellungen/i })).toBeVisible();
  });
});
