import { test, expect } from '@playwright/test';

test.describe('Smoke', () => {
  test('Public Health-Endpoint liefert minimalen Status (keine internen Details)', async ({ request }) => {
    const res = await request.get('/api/health');
    // Healthy oder degraded — beides ist eine gültige Antwort. Wichtig:
    // KEIN 5xx (Endpoint selbst muss leben).
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body).toHaveProperty('timestamp');
    // N3-Sicherheit: KEINE internen Details auf dem Public-Endpoint —
    // weder Service-Liste, Hostnamen, Ports noch Fehlertexte. Diagnose-
    // Daten liegen auf /api/health/detail (Admin-only).
    expect(body).not.toHaveProperty('services');
    expect(body).not.toHaveProperty('postgres');
    expect(body).not.toHaveProperty('error');
  });

  test('Detail Health-Endpoint blockt unauthentifiziert', async ({ request }) => {
    const res = await request.get('/api/health/detail');
    // Erwartet 401 (kein Login) oder 403 (Login aber nicht Admin) — beides
    // ist akzeptabel. Wichtig: nicht 200, kein Detail-Leak ohne Auth.
    expect([401, 403]).toContain(res.status());
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
    expect(page.url()).toContain('/staff/login');
    if (res) expect(res.status()).toBe(200);
  });
});
