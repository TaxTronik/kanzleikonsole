import { test, expect } from '@playwright/test';
import { flushRedisDb } from './helpers/redis';

const TARGET_EMAIL = 'rate-limit-test@taxtronik.local';

test.describe('Rate-Limit', () => {
  test.afterEach(async () => {
    await flushRedisDb();
  });

  test('Magic-Link-Anfrage wird nach 5 Versuchen blockiert', async ({ page }) => {
    test.setTimeout(60_000);

    // Use a single fixed email to deterministically trigger per-IP rate limit.
    // Das Limit ist 5 Magic-Link-Anfragen pro 15 Minuten pro IP (actions.ts:32).
    // 5 Anfragen laufen durch, die 6. MUSS blockiert werden.
    for (let i = 0; i < 5; i++) {
      await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('E-Mail-Adresse').fill(TARGET_EMAIL);
      // Deterministisch statt fixem Sleep: auf die POST-Antwort der Server-Action
      // warten — sie beweist, dass die Anfrage serverseitig verarbeitet (der
      // Rate-Limit-Zähler erhöht) wurde, bevor die nächste Runde startet.
      // Wortunabhängig (Anti-Enumeration liefert eine generische Antwort).
      const respPromise = page.waitForResponse(
        (r) => r.url().includes('/portal/login') && r.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      await respPromise;
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
