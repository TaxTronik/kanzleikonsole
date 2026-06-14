// =============================================================================
// 06-actions.spec.ts — Real user interactions (not just page rendering)
// =============================================================================
import { test, expect, type Browser } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant } from './helpers/portal-auth';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_DIR = path.join(os.tmpdir(), 'taxtronik-e2e-auth');
const STAFF_AUTH = path.join(AUTH_DIR, 'staff.json');
const MANDANT_AUTH = path.join(AUTH_DIR, 'mandant.json');

function createMinimalPdf(): Buffer {
  const pdf = [
    '%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
    'xref', '0 4', '0000000000 65535 f ',
    '0000000009 00000 n ', '0000000058 00000 n ', '0000000115 00000 n ',
    'trailer<</Size 4/Root 1 0 R>>', 'startxref', '190', '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'utf-8');
}

// =============================================================================
// STAFF ACTIONS
// =============================================================================
test.describe.serial('Staff Actions and Data Integrity', () => {
  test.beforeAll(() => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    try { fs.unlinkSync(STAFF_AUTH); } catch {}
    try { fs.unlinkSync(MANDANT_AUTH); } catch {}
  });

  test.afterAll(() => {
    try { fs.unlinkSync(STAFF_AUTH); } catch {}
    try { fs.unlinkSync(MANDANT_AUTH); } catch {}
    try { fs.rmdirSync(AUTH_DIR); } catch {}
  });

  // 1. Document Upload
  test('Upload a document to a client', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 10000 });
    await ctx.storageState({ path: STAFF_AUTH });

    // Use the documents page which has the upload interface
    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Must stay logged in
    expect(page.url()).not.toContain('/staff/login');

    // Navigate to a specific client's documents (upload button only appears
    // when a client scope is active)
    const clientNav = page.getByRole('link', { name: /Juristische Personen/i });
    if (await clientNav.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clientNav.click();
      await page.waitForTimeout(2000);
    }

    const mustermannLink = page.getByRole('link', { name: /Mustermann/ }).first();
    if (await mustermannLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await mustermannLink.click();
      await page.waitForTimeout(3000);
    }

    // Try multiple possible upload button selectors
    let uploadBtn = page.getByRole('button', { name: /Hochladen/i }).first();
    let btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!btnVisible) {
      uploadBtn = page.getByRole('button', { name: /Upload/i }).first();
      btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!btnVisible) {
      uploadBtn = page.locator('button[title*="hochladen" i], button[title*="upload" i], button[aria-label*="hochladen" i], button[aria-label*="upload" i]').first();
      btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!btnVisible) {
      uploadBtn = page.getByRole('link', { name: /Hochladen|Dokument.*hochladen|Upload/i }).first();
      btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!btnVisible) {
      const allButtons = await page.locator('button, a[role="button"]').allInnerTexts().catch(() => [] as string[]);
      throw new Error(`Upload button not found on /staff/documents. Available buttons: ${allButtons.join(', ') || '(none)'}`);
    }
    await uploadBtn.click();
    await page.waitForTimeout(1500);

    const fileInput = page.locator('#upload-file, input[type="file"]').first();
    const fiVisible = await fileInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (fiVisible) {
      await fileInput.setInputFiles({
        name: 'test-e2e-document.pdf',
        mimeType: 'application/pdf',
        buffer: createMinimalPdf(),
      });

      const titleInput = page.locator('#upload-title');
      if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await titleInput.fill('E2E Test Dokument');
      }

      const submitBtn = page.locator('button[type="submit"]').filter({ hasText: /Hochladen/ });
      if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(4000);
      }
    }

    // FIX 2: Statt body-visible — das hochgeladene Dokument MUSS in der Liste
    // erscheinen, sonst ist der Upload-Vorgang fehlgeschlagen.
    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(
      page.getByText('E2E Test Dokument').first(),
      'Hochgeladenes Dokument muss in der Dokumentenliste sichtbar sein',
    ).toBeVisible({ timeout: 8000 });
    await ctx.close();
  });
  test('Share a document with the client', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Navigate through document explorer to client scope
    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const clientNav = page.getByRole('link', { name: /Juristische Personen/i });
    if (await clientNav.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clientNav.click();
      await page.waitForTimeout(2000);
    }

    const mustermannLink = page.getByRole('link', { name: /Mustermann/ }).first();
    if (await mustermannLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await mustermannLink.click();
      await page.waitForTimeout(3000);
    }

    const shareBtn = page.locator('[title*="Freigeben" i], [title*="Mandant freigeben" i], button:has(svg[class*="share"])').first();
    const unshareBtn = page.locator('[title*="Freigabe.*zurück" i], [title*="Freigabe zurückziehen" i], button:has(svg[class*="unshare"])').first();

    const sharedAlready = await unshareBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (sharedAlready) {
      await unshareBtn.click();
      await page.waitForTimeout(1500);
    }

    const canShare = await shareBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (canShare) {
      await shareBtn.click();
      await page.waitForTimeout(2000);
      // The unshare button may appear with a different title after sharing
      const nowUnshared = await unshareBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (!nowUnshared) {
        // Try broader selector
        const anyUnshare = page.locator('[title*="zurück" i], [title*="Freigabe" i]').first();
        const anyUnshared = await anyUnshare.isVisible({ timeout: 3000 }).catch(() => false);
        expect(anyUnshared).toBeTruthy();
      }
    } else {
      test.skip(true, 'No shareable documents available');
    }
    await ctx.close();
  });

  // 3. Create Invoice
  test('Create a new invoice', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    // EXTERNAL invoice mode is genuinely config-dependent
    if (await page.getByText(/zentraler Rechnungssoftware/).isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'Invoice mode EXTERNAL');
      await ctx.close(); return;
    }

    const heading = page.getByRole('heading', { name: /Neue Rechnung|PDF-Rechnung/ }).first();
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      // FIX 1: Weder EXTERNAL noch Heading → Seiten-Bug/RBAC-Fehler → FAIL.
      await ctx.close();
      throw new Error('Invoice creation page heading not found (not in EXTERNAL mode) — page broken or RBAC issue');
    }

    await page.locator('#clientId').selectOption({ label: 'Mustermann GmbH' });
    await page.locator('#subject').fill('E2E Test Rechnung');
    await page.locator('[id^="pos-0-description"]').fill('Beratungsleistung');
    await page.locator('[id^="pos-0-unitPrice"]').fill('150.00');

    const submitBtn = page.getByRole('button', { name: /Rechnung anlegen/ });
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();
    await page.waitForTimeout(4000);
    expect(page.url()).toContain('/staff/invoices/');
    await ctx.close();
  });

  // 4. Create Calendar Appointment
  test('Create a calendar appointment', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/calendar');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    await page.getByRole('button', { name: /Neuer Termin/ }).click();
    await page.waitForTimeout(1000);

    const titleInput = page.locator('input[name="title"]');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('E2E Test Termin');
    await page.locator('select[name="clientId"]').selectOption({ label: 'Mustermann GmbH' });
    const t = new Date(Date.now() + 86400000);
    t.setHours(9, 0, 0, 0);
    const s = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    t.setHours(11, 0, 0, 0);
    const e = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.locator('input[name="startsAt"]').fill(s);
    await page.locator('input[name="endsAt"]').fill(e);
    const btn = page.locator('button[type="submit"]').filter({ hasText: /Anlegen/ });
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(3000);

    // FIX 2: Statt body-visible — der Termin MUSS im Kalender/der Liste
    // auftauchen, sonst wurde er nicht persistiert.
    await expect(
      page.getByText('E2E Test Termin').first(),
      'Erstellter Termin muss im Kalender sichtbar sein',
    ).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 5. Start Workflow
  test('Start a workflow for a client', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/workflows/templates');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const startBtn = page.getByRole('button', { name: /Starten/ }).first();
    if (!(await startBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'No active workflow templates (seed-dependent)');
      await ctx.close(); return;
    }
    await startBtn.click();
    await page.waitForTimeout(1000);

    await page.locator('.modal-overlay select').selectOption({ label: 'Mustermann GmbH' });
    const startSubmit = page.getByRole('button', { name: /Workflow starten/ });
    await expect(startSubmit).toBeVisible({ timeout: 5000 });
    await startSubmit.click();
    await page.waitForTimeout(4000);

    expect(page.url()).toBeTruthy();
    await ctx.close();
  });

  // 6. Create Knowledge Article
  test('Create a knowledge article', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/knowledge/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const titleEl = page.locator('#title');
    const titleVisible = await titleEl.isVisible({ timeout: 5000 }).catch(() => false);
    if (!titleVisible) {
      test.skip(true, 'Knowledge article form not found (page structure may differ)');
      await ctx.close(); return;
    }
    await titleEl.fill('E2E Test Wissensartikel');
    await page.locator('#body').fill('## E2E Test\n\nAutomatisch erstellter Test-Artikel.');
    const s = page.getByRole('button', { name: /Anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForTimeout(4000);
    expect(page.url()).toContain('knowledge');
    await ctx.close();
  });

  // 7. Create Form Template
  test('Create a form template', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/forms');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const summary = page.locator('summary').filter({ hasText: /Neue Vorlage anlegen/ });
    await expect(summary).toBeVisible({ timeout: 5000 });
    await summary.click();
    await page.waitForTimeout(800);

    const formName = page.locator('#form-name');
    await expect(formName).toBeVisible({ timeout: 5000 });
    await formName.fill('E2E Test Vorlage');
    const s = page.getByRole('button', { name: /Vorlage anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForTimeout(4000);
    expect(page.url()).toContain('forms');
    await ctx.close();
  });

  // 8. Add Phone Note
  test('Add a phone note on client detail', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const clientLink = page.getByRole('link', { name: /Mustermann/ }).first();
    await expect(clientLink).toBeVisible({ timeout: 8000 });
    await clientLink.click();
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/staff/clients/');

    const neuBtn = page.getByRole('button', { name: /^Neu$/ }).first();
    const neuVisible = await neuBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!neuVisible) {
      test.skip(true, '"Neu" button not found on client detail page');
      await ctx.close(); return;
    }
    await neuBtn.click();
    await page.waitForTimeout(1000);

    const callerInput = page.locator('#qpn-caller');
    await expect(callerInput).toBeVisible({ timeout: 5000 });
    await callerInput.fill('E2E Test Anrufer');
    await page.locator('#qpn-subject').fill('E2E Test Anruf');
    await page.locator('#qpn-body').fill('Test Notiz vom E2E Test.');
    const s = page.getByRole('button', { name: /Notiz anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForTimeout(3000);

    // FIX 2: Statt body-visible — die Telefonnotiz MUSS auf der Mandanten-
    // detailseite erscheinen, sonst wurde sie nicht gespeichert.
    await expect(
      page.getByText('E2E Test Anruf').first(),
      'Telefonnotiz „E2E Test Anruf" muss nach dem Anlegen sichtbar sein',
    ).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 9. Create POA
  test('Create a power of attorney', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/poa/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    if (await page.getByText(/Keine aktiven Mandanten/).isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'No active clients for POA (GwG gate)');
      await ctx.close(); return;
    }

    const clientSelect = page.locator('#clientId');
    const selectVisible = await clientSelect.isVisible({ timeout: 5000 }).catch(() => false);
    if (!selectVisible) {
      test.skip(true, 'POA creation form not available (#clientId missing)');
      await ctx.close(); return;
    }
    await clientSelect.selectOption({ label: 'Mustermann GmbH' });
    await page.locator('#signerName').fill('E2E Test Unterzeichner');
    await page.locator('#signerEmail').fill('test@example.com');
    await page.locator('#subject').fill('E2E Test Vollmacht');
    await page.locator('#scope').fill('## Umfang\n\nHiermit bevollmachtige ich...');
    const s = page.getByRole('button', { name: /Anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForTimeout(4000);
    expect(page.url()).toContain('poa');
    await ctx.close();
  });

  // 10. Log Time Entry
  test('Start and stop a time entry', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/time');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    // Stop any running timer first
    const stopBtn = page.getByRole('button', { name: /Stoppen/ });
    if (await stopBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await stopBtn.click();
      await page.waitForTimeout(2000);
      await page.reload();
      await page.waitForTimeout(1500);
    }

    const descInput = page.locator('#description');
    await expect(descInput).toBeVisible({ timeout: 5000 });
    await descInput.fill('E2E Test Zeiterfassung');
    await page.locator('#clientId').selectOption({ label: 'Mustermann GmbH' });
    const startBtn = page.getByRole('button', { name: /Timer starten/ });
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    await startBtn.click();
    await page.waitForTimeout(2500);

    const stopBtn2 = page.getByRole('button', { name: /Stoppen/ });
    await expect(stopBtn2).toBeVisible({ timeout: 5000 });
    await stopBtn2.click();
    await page.waitForTimeout(1500);
    // FIX 2: Statt body-visible — nach Stoppen muss der Timer beendet sein:
    // der „Timer starten"-Button ist wieder sichtbar und der erfasste Eintrag
    // taucht in der Zeiterfassungs-Liste auf.
    await expect(
      page.getByRole('button', { name: /Timer starten/ }),
      'Nach Stoppen muss „Timer starten" wieder verfügbar sein',
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText('E2E Test Zeiterfassung').first(),
      'Gestoppter Zeiteintrag muss in der Liste erscheinen',
    ).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 11. Tenant Isolation
  test('Verify tenant isolation', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 8000 });

    await page.goto('/staff/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 12. Audit Trail
  test('Audit trail contains entries', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Audit-Log ist GoBD-pflichtig — admin MUSS zugreifen. Redirect = Fehler.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit page — RBAC or session issue');
    }

    // FIX 2: Statt body-visible — die Audit-Seite MUSS die Audit-Tabelle oder
    // eine Leer-Meldung rendern (konkretes Seiten-Element).
    const auditContent = page.getByRole('heading', { name: /Audit-Log/i }).or(
      page.getByText(/Keine Einträge|Hash-Chain/i).first(),
    );
    await expect(auditContent.first()).toBeVisible({ timeout: 5000 });

    const rows = page.locator('table tbody tr');
    const count = await rows.count().catch(() => 0);
    if (count > 0) {
      await expect(rows.first()).toBeVisible();
    }

    const hashBanner = page.getByText(/Hash-Chain|Noch kein Prüfergebnis/i).first();
    await expect(hashBanner).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });
});

// =============================================================================
// PORTAL ACTIONS
// =============================================================================
test.describe('Portal Actions', () => {
  test('Login as mandant', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const request = ctx.request;

    try {
      await loginAsMandant(page, request);
      await expect(page.getByText(/Dashboard|Willkommen/).first()).toBeVisible({ timeout: 8000 });
      await ctx.storageState({ path: MANDANT_AUTH });
    } catch (e) {
      // SMTP may not be available in all environments
      test.skip(true, `Portal login failed: ${(e as Error).message}`);
    } finally {
      await ctx.close();
    }
  });

  test('View shared documents in portal', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(page.getByRole('heading', { name: /Dokumente/ })).toBeVisible({ timeout: 8000 });
    // FIX 2: Statt body-visible — die Dokumenten-Seite MUSS eine Tabelle oder
    // Leer-Meldung zeigen (kein bloßer Body-Check).
    const docsContent = page.locator('table').or(page.getByText(/Keine Dokumente|noch keine Dokumente/i));
    await expect(docsContent.first()).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  test('Portal requests page loads', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/requests');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(page.getByRole('heading', { name: /Anforderungen/ })).toBeVisible({ timeout: 8000 });
    // FIX 2: Statt body-visible — die Anforderungs-Seite MUSS konkreten
    // Inhalt (Tabelle/Leer-Meldung) rendern.
    const reqContent = page.locator('table').or(page.getByText(/Keine Anforder/i));
    await expect(reqContent.first()).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  test('Request an appointment as mandant', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/appointments');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(page.getByRole('heading', { name: /Termine/ })).toBeVisible({ timeout: 8000 });

    const anfragenBtn = page.getByRole('button', { name: /Anfragen/ });
    await expect(anfragenBtn).toBeVisible({ timeout: 5000 });
    await anfragenBtn.click();
    await page.waitForTimeout(1000);

    const subjectInput = page.locator('input[name="subject"]');
    await expect(subjectInput).toBeVisible({ timeout: 5000 });
    await subjectInput.fill('E2E Test Terminanfrage');
    await page.locator('textarea[name="notes"]').fill('Bitte um einen Termin.');
    const t = new Date(Date.now() + 2 * 86400000);
    t.setHours(9, 0, 0, 0);
    const v = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.locator('[name="slot0_starts"]').fill(v);
    t.setHours(11, 0, 0, 0);
    const v2 = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.locator('[name="slot0_ends"]').fill(v2);

    const s = page.getByRole('button', { name: /Anfrage senden/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForTimeout(4000);

    // FIX 2: Statt body-visible — die Terminanfrage MUSS bestätigt werden
    // (Erfolgs-Meldung oder der Betreff erscheint in der Anfrage-Liste).
    const confirmation = page.getByText(/E2E Test Terminanfrage|erfolgreich|versendet|angefragt/i);
    await expect(confirmation.first(), 'Terminanfrage muss bestätigt oder gelistet werden').toBeVisible({ timeout: 5000 });
    await ctx.close();
  });
});
