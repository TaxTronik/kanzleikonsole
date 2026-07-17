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
    const adminSidebar = page.locator('aside.app-sidebar');
    const privacyLink = adminSidebar.getByRole('link', {
      name: 'Datenschutz',
      exact: true,
    });
    const settingsLink = adminSidebar.getByRole('link', {
      name: 'Einstellungen',
      exact: true,
    });

    await expect(privacyLink).toBeVisible();
    await expect(privacyLink).toHaveAttribute('href', '/staff/admin/privacy');
    await expect(settingsLink).toBeVisible();
    await expect(settingsLink).toHaveAttribute('href', '/staff/admin/settings');
  });
});
