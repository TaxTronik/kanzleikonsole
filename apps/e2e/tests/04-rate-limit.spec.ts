import { test, expect } from '@playwright/test';

const TARGET_EMAIL = 'rate-limit-test@taxtronik.local';

test.describe('Rate-Limit', () => {
  test('Magic-Link-Anfrage wird nach 5 Versuchen blockiert', async ({ page }) => {
    test.setTimeout(60_000);

    // Use a single fixed email to deterministically trigger per-IP rate limit.
    // The rate limit is 10 magic-link requests per 10 minutes per IP.
    // Sending 6 rapid requests from the same IP should trigger the block.
    for (let i = 0; i < 5; i++) {
      await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('E-Mail-Adresse').fill(TARGET_EMAIL);
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      await page.waitForTimeout(200);
    }

    // 6th request MUST trigger rate limiting
    await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('E-Mail-Adresse').fill(TARGET_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();

    // Strict assertion: the 6th request MUST show the rate-limit error
    await expect(page.getByText(/Zu viele Anfragen/i)).toBeVisible({ timeout: 10_000 });

    // Verify no success message is shown concurrently
    const successVisible = await page.getByText(/Login-Link verschickt/i).isVisible().catch(() => false);
    expect(successVisible).toBe(false);
  });
});
