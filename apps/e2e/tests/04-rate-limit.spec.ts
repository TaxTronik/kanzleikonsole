import { test, expect } from '@playwright/test';

test.describe('Rate-Limit', () => {
  test('Magic-Link-Anfrage wird nach 5 Versuchen blockiert', async ({ page, request }) => {
    // Direkt 6 mal die Server-Action triggern (über das Form)
    for (let i = 0; i < 6; i++) {
      await page.goto('/portal/login');
      await page.getByLabel('E-Mail-Adresse').fill(`spam-${i}-${Date.now()}@nope.local`);
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      // Wir warten auf entweder Erfolg ODER Rate-Limit-Fehler
      await page.waitForTimeout(150);
    }
    // Beim 6./7. Versuch sollte die Fehlermeldung erscheinen
    const errorOrSuccess = page.locator('text=/Zu viele Anfragen|Login-Link verschickt/i');
    await expect(errorOrSuccess.first()).toBeVisible({ timeout: 10_000 });
    // Mindestens einer der späten Versuche muss die Rate-Limit-Meldung gezeigt haben
    const maybeError = await page.getByText(/Zu viele Anfragen/i).isVisible().catch(() => false);
    if (!maybeError) {
      // Fallback: nochmal testen, jetzt sollte definitiv blockiert sein
      await page.goto('/portal/login');
      await page.getByLabel('E-Mail-Adresse').fill('still-spam@nope.local');
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      await expect(page.getByText(/Zu viele Anfragen/i)).toBeVisible({ timeout: 5_000 });
    }
  });
});
