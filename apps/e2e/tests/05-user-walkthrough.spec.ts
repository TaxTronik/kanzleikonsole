// =============================================================================
// User-Walkthrough: Klickt sich wie ein Steuerberater UND Mandant durch die App
// =============================================================================
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant, PORTAL_EMAIL } from './helpers/portal-auth';

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

// ===========================================================================
// STAFF-SIDE (Steuerberater/Kanzlei-Mitarbeiter)
// ===========================================================================
test.describe('Staff: Core-Flows', () => {
  test('Login & Dashboard mit Widgets', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible();
    await expect(page.locator('.react-grid-layout')).toBeVisible();
  });

  test('Globale Suche findet Mandant und Anforderung', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByPlaceholder(/Mandanten, Anforderungen/i);
    await search.click();
    await search.fill('Mustermann');
    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 5000 });
  });

  test('Mandanten-Liste mit Test-Mandant', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible();
  });

  test('Mandanten-Detail: Cockpit-Blöcke sichtbar', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    await page.getByText('Mustermann GmbH').first().click();
    await expect(page).toHaveURL(/\/staff\/clients\//);
    await expect(page.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  });

  test('Mandant bearbeiten: Stammdaten-Formular', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    await page.getByText('Mustermann GmbH').first().click();
    await page.getByRole('link', { name: /Stammdaten bearbeiten/i }).click();
    await expect(page.getByLabel(/Firma|Name/i).first()).toBeVisible();
    // Formular sollte den Namen enthalten
    const firmaInput = page.getByLabel(/Firma|Name/i).first();
    await expect(firmaInput).toHaveValue(/Mustermann/);
  });

  test('Neuen Mandanten anlegen (Formular öffnet)', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients/new');
    // Onboarding-Formular sollte sichtbar sein
    await expect(page.getByText(/Neuen Mandanten|Onboarding/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Dokumente: Explorer zeigt Grid', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/documents');
    await expect(page.locator('.grid-cols-\\[240px_1fr\\]').first()).toBeVisible({ timeout: 5000 });
  });

  test('Rechnungen: Neue Rechnung Formular', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/invoices/new');
    await expect(page.getByLabel(/Mandant/i)).toBeVisible({ timeout: 5000 });
  });

  test('Workflows: Übersicht & Quick-Start', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/workflows');
    await expect(page.getByText(/Workflows|Instanzen/i).first()).toBeVisible();
  });

  test('Wissensdatenbank: Artikel-Liste', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/knowledge');
    await expect(page.getByText(/Wissensdatenbank|Artikel/i).first()).toBeVisible();
  });

  test('Formulare: Form-Builder-Übersicht', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/forms');
    await expect(page.getByText(/Formulare|Form-Builder/i).first()).toBeVisible();
  });

  test('Kalender: Termin-Übersicht', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/calendar');
    await expect(page.getByText(/Kalender|Termine/i).first()).toBeVisible();
  });

  test('Steuertermine: Fristen-Übersicht', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/tax-deadlines');
    await expect(page.getByText(/Steuertermine|Fristen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Vollmachten: POA-Liste', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/poa');
    await expect(page.getByText(/Vollmachten|Vertretung/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Zeiterfassung: Time-Tracking', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/time');
    await expect(page.getByText(/Zeit|Erfassung/i).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Staff: Admin & Konfiguration', () => {
  test('Admin: Dashboard/Einstellungen erreichbar', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/admin');
    await expect(page.getByText(/Einstellungen|Administration/i).first()).toBeVisible();
  });

  test('Admin: Benutzerverwaltung zeigt Admin', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/admin/users');
    await expect(page.getByText('admin@taxtronik.local')).toBeVisible();
  });

  test('Admin: Audit-Log einsehbar', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/admin/audit');
    await expect(page.getByText(/Audit|Protokoll/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Admin: Kanzlei-Einstellungen (Settings)', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/admin/settings');
    await expect(page.getByText(/Allgemein|Kanzlei/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('UI: Benachrichtigungen & Abmelden', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByLabel(/Benachrichtigungen/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Abmelden/i })).toBeVisible();
  });

  test('UI: Theme wechseln', async ({ page }) => {
    await loginAsAdmin(page);
    const themeBtn = page.getByLabel(/System.*Hell|Hell|Dunkel/i).first();
    if (await themeBtn.isVisible().catch(() => false)) {
      await themeBtn.click();
      await page.waitForTimeout(400);
    }
  });
});

// ===========================================================================
// PORTAL-SIDE (Mandant)
// ===========================================================================
test.describe('Portal: Mandanten-Login & Features', () => {
  test('Portal-Login-Seite öffentlich erreichbar', async ({ page }) => {
    await page.goto('/portal/login');
    await expect(page.getByText(/Mandantenportal/i)).toBeVisible();
    await expect(page.getByLabel('E-Mail-Adresse')).toBeVisible();
  });

  test('Magic-Link anfordern zeigt Erfolgsmeldung', async ({ page }) => {
    await page.goto('/portal/login', { waitUntil: 'networkidle' });
    await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
    await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 5000 });
  });

  test('Magic-Link Login & Portal-Dashboard', async ({ page }) => {
    await loginAsMandant(page);
    await expect(page.getByText(/Dashboard|Willkommen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Dokumente einsehbar', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/documents');
    await expect(page.getByText(/Dokumente|Dateien/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Anforderungen (Requests)', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/requests');
    await expect(page.getByText(/Anforderungen|Anfragen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Formulare', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/forms');
    await expect(page.getByText(/Formulare|ausfüllen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Rechnungen', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/invoices');
    await expect(page.getByText(/Rechnungen|Zahlungen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Termine (Appointments)', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/appointments');
    await expect(page.getByText(/Termine|Appointments/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Stammdaten-Self-Service', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/stammdaten');
    await expect(page.getByText(/Stammdaten|Änderungen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Einstellungen (Settings)', async ({ page }) => {
    await loginAsMandant(page);
    await page.goto('/portal/settings');
    await expect(page.getByText(/Einstellungen|Benachrichtigungen/i).first()).toBeVisible({ timeout: 5000 });
  });
});

// ===========================================================================
// ÖFFENTLICHE SEITEN & SONSTIGES
// ===========================================================================
test.describe('Öffentliche Seiten & Cross-Cutting', () => {
  test('GwG-Onboarding-Seite ist öffentlich', async ({ page }) => {
    await page.goto('/gwg-onboarding');
    // Kann leer sein (kein Token), aber sollte zumindest laden
    await expect(page.locator('body')).toBeVisible();
  });

  test('Health-Endpoint (ohne Auth)', async ({ request }) => {
    const res = await request.get('/api/health');
    expect([200, 503]).toContain(res.status());
  });

  test('Responsive: Mobile Viewport (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/staff/login');
    await page.waitForTimeout(500);
    await expect(page.getByText(/Mitarbeiter-Login/i)).toBeVisible();
  });
});
