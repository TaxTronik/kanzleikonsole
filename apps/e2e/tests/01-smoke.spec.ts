import { test, expect } from '@playwright/test';

test.describe('Smoke', () => {
  test('Health-Endpoint liefert OK', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.services.postgres.ok).toBe(true);
    expect(body.services.redis.ok).toBe(true);
    expect(body.services.objectStore.ok).toBe(true);
    expect(body.services.clamav.ok).toBe(true);
  });

  test('Staff-Login-Page rendert', async ({ page }) => {
    await page.goto('/staff/login');
    await expect(page.getByText(/Mitarbeiter-Login/i)).toBeVisible();
    await expect(page.getByLabel('E-Mail')).toBeVisible();
    await expect(page.getByLabel('Passwort')).toBeVisible();
  });

  test('Portal-Login-Page rendert', async ({ page }) => {
    await page.goto('/portal/login');
    await expect(page.getByText(/Mandantenportal/i)).toBeVisible();
    await expect(page.getByLabel('E-Mail-Adresse')).toBeVisible();
  });

  test('n8n-Endpoint blockt ohne HMAC mit 401', async ({ request }) => {
    const res = await request.get('/api/n8n/overdue-requests');
    expect(res.status()).toBe(401);
  });

  test('Geschützte Staff-Route ohne Login → Redirect zu /staff/login', async ({ page }) => {
    const res = await page.goto('/staff/dashboard', { waitUntil: 'domcontentloaded' });
    // Browser folgt automatisch dem Redirect
    expect(page.url()).toContain('/staff/login');
    if (res) expect(res.status()).toBe(200); // Login-Seite
  });
});
