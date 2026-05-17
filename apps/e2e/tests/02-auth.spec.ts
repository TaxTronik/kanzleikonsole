import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

test.describe('Auth-Flow', () => {
  test.skip(
    !process.env['E2E_TOTP_SECRET'],
    'Setze E2E_TOTP_SECRET=… damit dieser Test laufen kann ' +
      '(Wert siehst du beim ersten Login im UI unter dem QR-Code).',
  );

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

  test('Admin sieht Admin-Sidebar (DSGVO + Einstellungen)', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole('link', { name: /DSGVO/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Einstellungen/i })).toBeVisible();
  });
});
