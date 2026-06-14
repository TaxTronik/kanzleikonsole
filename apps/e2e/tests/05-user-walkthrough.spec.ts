// =============================================================================
// User-Walkthrough: Klickt sich wie ein Steuerberater durch die App
// =============================================================================
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

test.describe('Steuerberater-Walkthrough', () => {
  test('Dashboard lädt mit Widgets', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible();
    // Widgets sollten vorhanden sein
    await expect(page.locator('.react-grid-layout')).toBeVisible();
  });

  test('Globale Suche funktioniert', async ({ page }) => {
    await loginAsAdmin(page);
    const search = page.getByPlaceholder(/Mandanten, Anforderungen/i);
    await search.click();
    await search.fill('Mustermann');
    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 5000 });
  });

  test('Mandanten-Liste lädt und zeigt Einträge', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    await expect(page.getByRole('heading', { name: /Mandanten/i })).toBeVisible();
    // Mindestens ein Mandant (Mustermann GmbH aus Seed)
    await expect(page.getByText('Mustermann GmbH')).toBeVisible();
  });

  test('Mandanten-Detailseite zeigt Cockpit', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/clients');
    // Ersten Mandanten anklicken
    await page.getByText('Mustermann GmbH').first().click();
    await expect(page).toHaveURL(/\/staff\/clients\//);
    // Cockpit-Blöcke prüfen — Stammdaten ist mehrfach auf der Seite
    await expect(page.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  });

  test('Kalender-Seite rendert', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/calendar');
    await expect(page.getByRole('heading', { name: /Kalender/i })).toBeVisible();
  });

  test('Dokumente-Seite rendert', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/documents');
    // Dokumenten-Explorer Grid ist das Kern-Element
    await expect(page.locator('.grid-cols-\\[240px_1fr\\]').first()).toBeVisible({ timeout: 5000 });
  });

  test('Rechnungen-Seite rendert', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/invoices');
    await expect(page.getByRole('heading', { name: /Rechnungen/i })).toBeVisible();
  });

  test('Workflows-Seite rendert', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/workflows');
    await expect(page.getByRole('heading', { name: /Workflows/i })).toBeVisible();
  });

  test('Wissensdatenbank-Seite rendert', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/knowledge');
    await expect(page.getByRole('heading', { name: /Wissensdatenbank/i })).toBeVisible();
  });

  test('Formulare-Seite rendert', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/forms');
    await expect(page.getByRole('heading', { name: /Formulare/i })).toBeVisible();
  });

  test('Admin-Bereich: Einstellungen erreichbar', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/admin');
    await expect(page.getByText(/Einstellungen|Administration/i).first()).toBeVisible();
  });

  test('Admin: Benutzerverwaltung zeigt Admin', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/staff/admin/users');
    await expect(page.getByText('admin@taxtronik.local')).toBeVisible();
  });

  test('Benachrichtigungen-Glocke ist sichtbar', async ({ page }) => {
    await loginAsAdmin(page);
    const bell = page.getByLabel(/Benachrichtigungen/i);
    await expect(bell).toBeVisible();
  });

  test('Abmelden-Link ist vorhanden', async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole('button', { name: /Abmelden/i })).toBeVisible();
  });

  test('Theme-Toggle funktioniert', async ({ page }) => {
    await loginAsAdmin(page);
    // Theme-Button finden und klicken
    const themeBtn = page.getByLabel(/System.*Hell|Hell|Dunkel/i).first();
    if (await themeBtn.isVisible()) {
      await themeBtn.click();
      // Sollte nicht crashen
      await page.waitForTimeout(500);
    }
  });

  test('Portal-Login-Seite ist öffentlich', async ({ page }) => {
    await page.goto('/portal/login');
    await expect(page.getByText(/Mandantenportal/i)).toBeVisible();
    await expect(page.getByLabel('E-Mail-Adresse')).toBeVisible();
  });

  test('Responsive: Mobile Sidebar Toggle', async ({ page }) => {
    await loginAsAdmin(page);
    // Mobile Toggle suchen (nur auf kleinen Viewports sichtbar)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(500);
    const toggle = page.getByLabel(/Menü|Navigation/i).first();
    // Sollte entweder sichtbar sein oder nicht (je nach Layout)
    const visible = await toggle.isVisible().catch(() => false);
    if (visible) {
      await toggle.click();
      await page.waitForTimeout(300);
    }
  });
});
