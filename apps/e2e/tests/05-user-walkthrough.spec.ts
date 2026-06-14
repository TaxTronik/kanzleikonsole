// =============================================================================
// User-Walkthrough: Klickt sich wie Steuerberater & Mandant durch die App
// =============================================================================
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant, requestMagicLink, PORTAL_EMAIL } from './helpers/portal-auth';

// ===========================================================================
// STAFF-SIDE — serial damit pro Test kein neuer Login nötig ist
// ===========================================================================
test.describe.serial('Staff: Core-Flows', () => {
  test('Login & Dashboard mit Widgets', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible();
    await expect(page.locator('.react-grid-layout')).toBeVisible();
  });

  test('Globale Suche findet Mandant', async ({ page }) => {
    // Suche via Tastatur-Shortcut oder Klick auf Such-Icon öffnen
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    const searchInput = page.getByPlaceholder(/Mandanten, Anforderungen/);
    // Fallback: manuell Input suchen falls Shortcut nicht greift
    if (!(await searchInput.isVisible().catch(() => false))) {
      await page.goto('/staff/clients'); // Clients-Seite hat immer Such-Input
    }
    const input = page.getByPlaceholder(/Mandanten, Anforderungen/).first();
    await input.click().catch(() => {});
    await input.fill('Mustermann');
    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 5000 });
  });

  test('Mandanten-Liste mit Test-Mandant', async ({ page }) => {
    await page.goto('/staff/clients');
    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible();
  });

  test('Mandanten-Detail: Cockpit-Blöcke', async ({ page }) => {
    await page.getByText('Mustermann GmbH').first().click();
    await expect(page).toHaveURL(/\/staff\/clients\//);
    await expect(page.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  });

  test('Mandant bearbeiten: Formular öffnet', async ({ page }) => {
    await page.getByRole('link', { name: /Stammdaten bearbeiten/i }).click();
    // Client-Edit-Seite hat input-Felder
    await expect(page.locator('input').first()).toBeVisible({ timeout: 5000 });
  });

  test('Dokumente: Explorer mit Sidebar', async ({ page }) => {
    await page.goto('/staff/documents');
    // Sidebar mit "Ordner" oder "Alle" sollte sichtbar sein
    await expect(page.getByText(/Ordner|Alle/).first()).toBeVisible({ timeout: 5000 });
  });

  test('Rechnungen: Neue Rechnung Formular', async ({ page }) => {
    await page.goto('/staff/invoices/new');
    await expect(page.getByText(/Rechnung|Mandant/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Workflows: Übersicht', async ({ page }) => {
    await page.goto('/staff/workflows');
    await expect(page.getByText(/Workflow|Instanz/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Wissensdatenbank', async ({ page }) => {
    await page.goto('/staff/knowledge');
    await expect(page.getByText(/Wissen|Artikel/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Formulare: Builder', async ({ page }) => {
    await page.goto('/staff/forms');
    await expect(page.getByText(/Formular/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Kalender', async ({ page }) => {
    await page.goto('/staff/calendar');
    await expect(page.getByText(/Kalender|Termin/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Steuertermine', async ({ page }) => {
    await page.goto('/staff/tax-deadlines');
    await expect(page.getByText(/Steuertermin|Frist/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Vollmachten (POA)', async ({ page }) => {
    await page.goto('/staff/poa');
    await expect(page.getByText(/Vollmacht|Vertretung/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Zeiterfassung', async ({ page }) => {
    await page.goto('/staff/time');
    await expect(page.getByText(/Zeit|Erfassung/i).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe.serial('Staff: Admin & Konfiguration', () => {
  test('Login für Admin-Tests', async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('Admin Dashboard', async ({ page }) => {
    await page.goto('/staff/admin');
    // Admin-Seite zeigt entweder License-Info oder Admin-Navigation
    await expect(page.locator('h1, h2, .card').first()).toBeVisible({ timeout: 5000 });
  });

  test('Benutzerverwaltung', async ({ page }) => {
    await page.goto('/staff/admin/users');
    await expect(page.getByText('admin@taxtronik.local')).toBeVisible();
  });

  test('Audit-Log', async ({ page }) => {
    await page.goto('/staff/admin/audit');
    await expect(page.getByText(/Audit|Protokoll/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Kanzlei-Einstellungen', async ({ page }) => {
    await page.goto('/staff/admin/settings');
    await expect(page.getByText(/Allgemein|Kanzlei|SMTP|Module/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Benachrichtigungen & Abmelden', async ({ page }) => {
    await page.goto('/staff/dashboard');
    await expect(page.getByLabel(/Benachrichtigungen/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Abmelden/i })).toBeVisible();
  });
});

// ===========================================================================
// PORTAL-SIDE
// ===========================================================================
test.describe.serial('Portal: Mandanten-Login & Features', () => {
  test('Portal-Login-Seite öffentlich', async ({ page }) => {
    await page.goto('/portal/login');
    await expect(page.getByText(/Mandantenportal/i)).toBeVisible();
    await expect(page.getByLabel('E-Mail-Adresse')).toBeVisible();
  });

  test('Magic-Link anfordern', async ({ page }) => {
    await requestMagicLink(page);
  });

  test('Magic-Link Login & Dashboard', async ({ page, request }) => {
    await loginAsMandant(page, request);
    await expect(page.getByText(/Dashboard|Willkommen/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Dokumente', async ({ page }) => {
    await page.goto('/portal/documents');
    await expect(page.getByText(/Dokument|Datei/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Anforderungen', async ({ page }) => {
    await page.goto('/portal/requests');
    await expect(page.getByText(/Anforderung|Anfrage/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Formulare', async ({ page }) => {
    await page.goto('/portal/forms');
    await expect(page.getByText(/Formular/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Rechnungen', async ({ page }) => {
    await page.goto('/portal/invoices');
    await expect(page.getByText(/Rechnung|Zahlung/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Termine', async ({ page }) => {
    await page.goto('/portal/appointments');
    await expect(page.getByText(/Termin|Appointment/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Stammdaten', async ({ page }) => {
    await page.goto('/portal/stammdaten');
    await expect(page.getByText(/Stammdaten|Änderung/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('Portal: Einstellungen', async ({ page }) => {
    await page.goto('/portal/settings');
    await expect(page.getByText(/Einstellung|Benachrichtigung/i).first()).toBeVisible({ timeout: 5000 });
  });
});

// ===========================================================================
// ÖFFENTLICHE SEITEN
// ===========================================================================
test.describe('Öffentliche Seiten & Cross-Cutting', () => {
  test('GwG-Onboarding (öffentlich)', async ({ page }) => {
    await page.goto('/gwg-onboarding');
    await expect(page.locator('body')).toBeVisible();
  });

  test('Health-Endpoint', async ({ request }) => {
    const res = await request.get('/api/health');
    expect([200, 503]).toContain(res.status());
  });

  test('Mobile Viewport (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/staff/login');
    await page.waitForTimeout(500);
    await expect(page.getByText(/Mitarbeiter-Login/i)).toBeVisible();
  });
});
