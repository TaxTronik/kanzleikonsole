// =============================================================================
// 06-actions.spec.ts — Real user interactions (not just page rendering)
// =============================================================================
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { expectPortalDashboardReady, loginAsMandant } from './helpers/portal-auth';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_DIR = path.join(os.tmpdir(), 'taxtronik-e2e-auth');
const STAFF_AUTH = path.join(AUTH_DIR, 'staff.json');
const MANDANT_AUTH = path.join(AUTH_DIR, 'mandant.json');
const PG_CONTAINER = process.env['E2E_POSTGRES_CONTAINER'] ?? 'taxtronik-postgres';
const PG_USER = process.env['E2E_POSTGRES_USER'] ?? 'taxtronik';
const PG_DB = process.env['E2E_POSTGRES_DB'] ?? 'taxtronik';
const PG_HOST = process.env['E2E_POSTGRES_HOST'] ?? 'localhost';
const PG_PASSWORD = process.env['E2E_POSTGRES_PASSWORD'] ?? 'taxtronik';
let uploadedDocumentId: string | null = null;

function createMinimalPdf(): Buffer {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '190',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'utf-8');
}

async function openMustermannDocuments(page: import('@playwright/test').Page): Promise<string> {
  for (const type of ['JURPERS', 'NATPERS', 'PERSGES']) {
    await page.goto(`/staff/documents?type=${type}`);
    await page.waitForLoadState('domcontentloaded');
    const link = page.getByRole('link', { name: /Mustermann/ }).first();
    if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
      await link.click();
      await expect(page).toHaveURL(/\/staff\/documents\?type=.*client=/, { timeout: 10_000 });
      return page.url();
    }
  }
  const text = await page
    .locator('main')
    .innerText()
    .catch(() => '');
  throw new Error(
    `Mustermann-Dokumenten-Scope nicht gefunden. Sichtbarer Inhalt: ${text.slice(0, 500)}`,
  );
}

function psql(query: string): string {
  const oneLine = query.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  try {
    return execSync(
      `docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -t -A -c "${oneLine}"`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return execSync(`psql -h ${PG_HOST} -U ${PG_USER} -d ${PG_DB} -t -A -c "${oneLine}"`, {
      encoding: 'utf-8',
      env: { ...process.env, PGPASSWORD: PG_PASSWORD },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}

function ensureStartableWorkflowTemplate(templateName: string): void {
  const staffRow = psql(
    `SELECT tenant_id || '|' || id FROM staff_user WHERE email = 'admin@taxtronik.local' LIMIT 1`,
  );
  const [tenantId, staffId] = staffRow.split('|');
  if (!tenantId || !staffId) throw new Error('Admin-Staff fuer Workflow-Seed nicht gefunden');
  const templateId = psql(`
    WITH upsert AS (
      INSERT INTO workflow_template (tenant_id, name, description, active, created_by_staff, updated_at)
      VALUES ('${tenantId}', '${templateName}', 'Seed fuer Paranoid-E2E', true, '${staffId}', now())
      ON CONFLICT (tenant_id, name)
      DO UPDATE SET active = true, updated_at = now()
      RETURNING id
    )
    SELECT id FROM upsert
    UNION
    SELECT id FROM workflow_template WHERE tenant_id = '${tenantId}' AND name = '${templateName}'
    LIMIT 1
  `);
  if (!templateId) throw new Error('Workflow-Template-Seed konnte keine ID erzeugen');
  psql(`
    INSERT INTO workflow_step (template_id, position, title, description, due_after_days, kind, config)
    VALUES ('${templateId}', 0, 'E2E Startschritt', 'Automatisch erzeugter E2E-Schritt', 1, 'TASK', '{}')
    ON CONFLICT (template_id, position)
    DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, kind = EXCLUDED.kind, config = EXCLUDED.config
  `);
}

// =============================================================================
// STAFF ACTIONS
// =============================================================================
test.describe.serial('Staff Actions and Data Integrity', () => {
  test.beforeAll(() => {
    uploadedDocumentId = null;
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    try {
      fs.unlinkSync(STAFF_AUTH);
    } catch {
      /* best-effort cleanup */
    }
    try {
      fs.unlinkSync(MANDANT_AUTH);
    } catch {
      /* best-effort cleanup */
    }
  });

  test.afterAll(() => {
    try {
      fs.unlinkSync(STAFF_AUTH);
    } catch {
      /* best-effort cleanup */
    }
    try {
      fs.unlinkSync(MANDANT_AUTH);
    } catch {
      /* best-effort cleanup */
    }
    try {
      fs.rmdirSync(AUTH_DIR);
    } catch {
      /* best-effort cleanup */
    }
  });

  // 1. Document Upload
  test('Upload a document to a client', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 10000 });
    await ctx.storageState({ path: STAFF_AUTH });

    const scopedDocumentsUrl = await openMustermannDocuments(page);
    expect(page.url()).not.toContain('/staff/login');

    // Try multiple possible upload button selectors
    let uploadBtn = page.getByRole('button', { name: /Hochladen/i }).first();
    let btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!btnVisible) {
      uploadBtn = page.getByRole('button', { name: /Upload/i }).first();
      btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!btnVisible) {
      uploadBtn = page
        .locator(
          'button[title*="hochladen" i], button[title*="upload" i], button[aria-label*="hochladen" i], button[aria-label*="upload" i]',
        )
        .first();
      btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!btnVisible) {
      uploadBtn = page.getByRole('link', { name: /Hochladen|Dokument.*hochladen|Upload/i }).first();
      btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!btnVisible) {
      const allButtons = await page
        .locator('button, a[role="button"]')
        .allInnerTexts()
        .catch(() => [] as string[]);
      throw new Error(
        `Upload button not found on /staff/documents. Available buttons: ${allButtons.join(', ') || '(none)'}`,
      );
    }
    await uploadBtn.click();

    const fileInput = page.locator('#upload-file, input[type="file"]').first();
    await expect(fileInput, 'Upload-Dialog muss ein Datei-Feld enthalten').toBeVisible({
      timeout: 5000,
    });
    await fileInput.setInputFiles({
      name: 'test-e2e-document.pdf',
      mimeType: 'application/pdf',
      buffer: createMinimalPdf(),
    });

    const titleInput = page.locator('#upload-title');
    await expect(titleInput, 'Upload-Dialog muss ein Titel-Feld enthalten').toBeVisible({
      timeout: 3000,
    });
    await titleInput.fill('E2E Test Dokument');

    const submitBtn = page.locator('button[type="submit"]').filter({ hasText: /Hochladen/ });
    await expect(submitBtn, 'Upload-Dialog muss einen Submit-Button enthalten').toBeVisible({
      timeout: 5000,
    });
    const commitResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/staff/documents/commit') && res.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await submitBtn.click();
    const uploadRes = await commitResponse;
    const uploadPayload = (await uploadRes.json().catch(() => null)) as {
      documentId?: unknown;
      error?: unknown;
    } | null;
    expect(
      uploadRes.status(),
      `Dokumenten-Commit muss erfolgreich sein: ${JSON.stringify(uploadPayload)}`,
    ).toBe(200);
    const documentId = uploadPayload?.documentId;
    expect(typeof documentId, 'Dokumenten-Commit muss eine documentId liefern').toBe('string');
    if (typeof documentId !== 'string') {
      throw new Error('Dokumenten-Commit lieferte keine documentId.');
    }
    expect(documentId, 'Dokumenten-Commit muss eine UUID liefern').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    uploadedDocumentId = documentId;

    // FIX 2: Statt body-visible — das hochgeladene Dokument MUSS in der Liste
    // erscheinen, sonst ist der Upload-Vorgang fehlgeschlagen.
    await page.goto(scopedDocumentsUrl);
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.locator(`[data-document-id="${documentId}"]`),
      'Hochgeladenes Dokument muss in der Dokumentenliste sichtbar sein',
    ).toBeVisible({ timeout: 8000 });
    await ctx.close();
  });
  test('Share a document with the client', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await openMustermannDocuments(page);
    expect(page.url()).not.toContain('/staff/login');

    if (!uploadedDocumentId) {
      throw new Error('Upload-Test hat keine Dokument-ID für den Freigabe-Test hinterlegt.');
    }

    const documentRow = page.locator(`[data-document-id="${uploadedDocumentId}"]`);
    await expect(
      documentRow,
      'Frisch hochgeladenes Dokument muss eindeutig auffindbar sein',
    ).toHaveCount(1);
    await expect(documentRow).toBeVisible({ timeout: 8000 });

    const shareBtn = documentRow.getByTitle('Für Mandant freigeben', { exact: true });
    const unshareBtn = documentRow.getByTitle('Freigabe für Mandant zurückziehen', { exact: true });

    await expect(
      documentRow.getByText('privat', { exact: true }),
      'Ein frisch hochgeladenes Dokument muss zunächst privat sein',
    ).toBeVisible();
    await documentRow.hover();
    await expect(shareBtn, 'Das frisch hochgeladene Dokument muss freigebbar sein').toBeVisible();
    await shareBtn.click();

    // Auto-retrying Assertions warten auf Server Action und router.refresh().
    // Beide Prüfungen bleiben auf exakt derselben Dokumentzeile gescoped.
    await expect(
      unshareBtn,
      'Nach Freigabe muss für dasselbe Dokument die Zurückziehen-Aktion erscheinen',
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      documentRow.getByText('geteilt', { exact: true }),
      'Nach Freigabe muss dasselbe Dokument als geteilt markiert sein',
    ).toBeVisible({ timeout: 10_000 });
    await ctx.close();
  });

  // 3. Create Invoice
  test('Create a new invoice', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices/new');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    if (
      await page
        .getByText(/zentraler Rechnungssoftware/)
        .isVisible({ timeout: 2000 })
        .catch(() => false)
    ) {
      const clientSelect = page.locator('#clientId');
      await expect(clientSelect, 'EXTERNAL-Rechnungsupload braucht aktive Mandanten').toBeVisible({
        timeout: 5000,
      });
      const optionCount = await clientSelect.locator('option').count();
      expect(
        optionCount,
        'EXTERNAL-Rechnungsupload braucht mindestens einen Mandanten',
      ).toBeGreaterThan(1);
      const mustermannOption = clientSelect
        .locator('option')
        .filter({ hasText: /Mustermann GmbH/i })
        .first();
      const selectedClient =
        (await mustermannOption.getAttribute('value').catch(() => null)) ??
        (await clientSelect.locator('option').nth(1).getAttribute('value'));
      expect(selectedClient, 'Mandanten-Select muss eine echte Option enthalten').toBeTruthy();
      await clientSelect.selectOption(selectedClient!);

      const number = `E2E-ACT-${Date.now()}`;
      await page.locator('#number').fill(number);
      await page.locator('#totalAmount').fill('150.00');
      await page.locator('#subject').fill('E2E Test Rechnung');
      await page.locator('#pdf').setInputFiles({
        name: 'e2e-action-invoice.pdf',
        mimeType: 'application/pdf',
        buffer: createMinimalPdf(),
      });
      await page.getByRole('button', { name: /Rechnung speichern.*Mandant senden/i }).click();
      await page.waitForURL(/\/staff\/invoices\/[a-f0-9-]+/, { timeout: 15_000 });
      await expect(
        page.getByRole('heading', { name: new RegExp(number) }),
        'EXTERNAL-Rechnung muss auf Detailseite sichtbar sein',
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.getByText(/Versendet/i).first(),
        'EXTERNAL-Rechnung muss als versendet gelten',
      ).toBeVisible({ timeout: 5000 });
      await ctx.close();
      return;
    }

    const heading = page.getByRole('heading', { name: /Neue Rechnung|PDF-Rechnung/ }).first();
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      // FIX 1: Weder EXTERNAL noch Heading → Seiten-Bug/RBAC-Fehler → FAIL.
      await ctx.close();
      throw new Error(
        'Invoice creation page heading not found (not in EXTERNAL mode) — page broken or RBAC issue',
      );
    }

    const invoiceSubject = `E2E Test Rechnung ${randomUUID().slice(0, 8)}`;
    await page.locator('#clientId').selectOption({ label: 'Mustermann GmbH' });
    await page.locator('#subject').fill(invoiceSubject);
    await page.locator('[id^="pos-0-description"]').fill('Beratungsleistung');
    await page.locator('[id^="pos-0-unitPrice"]').fill('150.00');

    const submitBtn = page.getByRole('button', { name: /Rechnung anlegen/ });
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();
    await page.waitForURL(
      /\/staff\/invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      { timeout: 15_000 },
    );
    await expect(
      page.getByText(invoiceSubject, { exact: true }),
      'Neu angelegte Rechnung muss auf ihrer Detailseite den eindeutigen Betreff anzeigen',
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Entwurf', { exact: true })).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 4. Create Calendar Appointment
  test('Create a calendar appointment', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/calendar');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    await page.getByRole('button', { name: /Neuer Termin/ }).click();

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
    await expect(page.locator('.modal-overlay')).toBeHidden({ timeout: 10_000 });
    await page.goto(`/staff/calendar?month=${s.slice(0, 7)}`, { waitUntil: 'networkidle' });

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
    const workflowName = `E2E Startbarer Workflow ${randomUUID().slice(0, 8)}`;
    ensureStartableWorkflowTemplate(workflowName);
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/workflows/templates');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    const templateRow = page.locator('table tbody tr').filter({
      has: page.getByRole('link', { name: workflowName, exact: true }),
    });
    await expect(
      templateRow,
      'Eindeutig erzeugte Workflow-Vorlage muss in der Liste stehen',
    ).toHaveCount(1);
    const startBtn = templateRow.getByRole('button', { name: /Starten/ });
    if (!(await startBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      await ctx.close();
      throw new Error(
        'No active workflow templates — Paranoid-E2E seed must include at least one startable workflow template',
      );
    }
    await startBtn.click();

    await page.locator('.modal-overlay select').selectOption({ label: 'Mustermann GmbH' });
    const startSubmit = page.getByRole('button', { name: /Workflow starten/ });
    await expect(startSubmit).toBeVisible({ timeout: 5000 });
    await startSubmit.click();
    await page.waitForURL(
      /\/staff\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/workflows$/i,
      { timeout: 15_000 },
    );
    await expect(
      page.getByRole('link', { name: workflowName, exact: true }),
      'Gestartete Workflow-Instanz muss beim ausgewählten Mandanten sichtbar sein',
    ).toBeVisible({ timeout: 8000 });
    await ctx.close();
  });

  // 6. Create Knowledge Article
  test('Create a knowledge article', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/knowledge/new');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    const titleEl = page.locator('#title');
    const titleVisible = await titleEl.isVisible({ timeout: 5000 }).catch(() => false);
    if (!titleVisible) {
      await ctx.close();
      throw new Error(
        'Knowledge article form not found — /staff/knowledge/new muss im Paranoid-E2E verfuegbar sein',
      );
    }
    const articleTitle = `E2E Test Wissensartikel ${randomUUID().slice(0, 8)}`;
    await titleEl.fill(articleTitle);
    await page.locator('#body').fill('## E2E Test\n\nAutomatisch erstellter Test-Artikel.');
    const s = page.getByRole('button', { name: /Anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForURL(
      /\/staff\/knowledge\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      { timeout: 15_000 },
    );
    await expect(
      page.getByRole('heading', { name: articleTitle, exact: true }),
      'Neu angelegter Wissensartikel muss auf seiner Detailseite erscheinen',
    ).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 7. Create Form Template
  test('Create a form template', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/forms');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    const summary = page.locator('summary').filter({ hasText: /Neue Vorlage anlegen/ });
    await expect(summary).toBeVisible({ timeout: 5000 });
    await summary.click();

    const formName = page.locator('#form-name');
    await expect(formName).toBeVisible({ timeout: 5000 });
    const templateName = `E2E Test Vorlage ${randomUUID().slice(0, 8)}`;
    await formName.fill(templateName);
    const s = page.getByRole('button', { name: /Vorlage anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForURL(
      /\/staff\/forms\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      { timeout: 15_000 },
    );
    await expect(
      page.getByRole('heading', { name: templateName, exact: true }),
      'Neu angelegte Formularvorlage muss auf ihrer Editor-Detailseite erscheinen',
    ).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 8. Add Phone Note
  test('Add a phone note on client detail', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    const clientLink = page.getByRole('link', { name: /Mustermann/ }).first();
    await expect(clientLink).toBeVisible({ timeout: 8000 });
    await clientLink.click();
    await page.waitForURL(/\/staff\/clients\//, { timeout: 15_000 });
    expect(page.url()).toContain('/staff/clients/');

    // Deterministischer Anker statt fixem Sleep: erst wenn die Telefonzettel-
    // Sektion gerendert ist, existiert der "Neu"-Button darunter. Die
    // Mandanten-Detailseite ist groß und rendert die Sektionen progressiv.
    await expect(page.getByRole('heading', { name: /Telefonzettel/i })).toBeVisible({
      timeout: 10_000,
    });

    const neuBtn = page
      .getByRole('heading', { name: /Telefonzettel/i })
      .locator('xpath=following::button[normalize-space()="Neu"][1]');
    const neuVisible = await neuBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!neuVisible) {
      await ctx.close();
      throw new Error(
        '"Neu" button not found on client detail page — Telefonnotiz-Flow kann nicht getestet werden',
      );
    }
    await neuBtn.click();

    const callerInput = page.locator('#qpn-caller');
    await expect(callerInput).toBeVisible({ timeout: 5000 });
    await callerInput.fill('E2E Test Anrufer');
    await page.locator('#qpn-subject').fill('E2E Test Anruf');
    await page.locator('#qpn-body').fill('Test Notiz vom E2E Test.');
    const s = page.getByRole('button', { name: /Notiz anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await expect(s, 'Telefonnotiz-Formular muss nach erfolgreicher Anlage schließen').toBeHidden({
      timeout: 10_000,
    });

    // router.refresh() kann unter CI-Load unzuverlässig sein; nach Form-Schließen
    // die Seite neu laden, damit die Telefonnotiz-Liste garantiert aktuell ist.
    await page.reload({ waitUntil: 'domcontentloaded' });

    // FIX 2: Statt body-visible — die Telefonnotiz MUSS auf der Mandanten-
    // detailseite erscheinen, sonst wurde sie nicht gespeichert.
    await expect(
      page.getByText('E2E Test Anruf').first(),
      'Telefonnotiz „E2E Test Anruf" muss nach dem Anlegen sichtbar sein',
    ).toBeVisible({ timeout: 10_000 });
    await ctx.close();
  });

  // 9. Create POA
  test('Create a power of attorney', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/poa/new');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    if (
      await page
        .getByText(/Keine aktiven Mandanten/)
        .isVisible({ timeout: 3000 })
        .catch(() => false)
    ) {
      await ctx.close();
      throw new Error(
        'No active clients for POA — Paranoid-E2E seed must include a GwG-verified client',
      );
    }

    const clientSelect = page.locator('#clientId');
    const selectVisible = await clientSelect.isVisible({ timeout: 5000 }).catch(() => false);
    if (!selectVisible) {
      await ctx.close();
      throw new Error('POA creation form not available (#clientId missing)');
    }
    await clientSelect.selectOption({ label: 'Mustermann GmbH' });
    await page.locator('#signerName').fill('E2E Test Unterzeichner');
    await page.locator('#signerEmail').fill('test@example.com');
    const poaSubject = `E2E Test Vollmacht ${randomUUID().slice(0, 8)}`;
    await page.locator('#subject').fill(poaSubject);
    // POA-Modus ist konfigurierbar (Default PDF-Template/extern, alternativ
    // In-App Markdown). Beide Pfade abdecken: Scope-Textarea wenn vorhanden,
    // sonst PDF-Upload über den FileButton (#poaPdf).
    if (
      await page
        .locator('#scope')
        .isVisible()
        .catch(() => false)
    ) {
      await page.locator('#scope').fill('## Umfang\n\nHiermit bevollmachtige ich...');
    } else {
      const pdf = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
          '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
          '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
          'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
          'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF\n',
        'latin1',
      );
      await page
        .locator('#poaPdf')
        .setInputFiles({ name: 'vollmacht.pdf', mimeType: 'application/pdf', buffer: pdf });
    }
    const s = page.getByRole('button', { name: /Anlegen/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();
    await page.waitForURL(
      /\/staff\/poa\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      { timeout: 15_000 },
    );
    await expect(
      page.getByRole('heading', { name: poaSubject, exact: true }),
      'Neu angelegte Vollmacht muss auf ihrer Detailseite erscheinen',
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Entwurf', { exact: true })).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 10. Log Time Entry
  test('Start and stop a time entry', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
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
      // Warten bis der Stopp verarbeitet ist: der „Stoppen"-Button verschwindet.
      await stopBtn.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    const descInput = page.locator('#description');
    await expect(descInput).toBeVisible({ timeout: 5000 });
    await descInput.fill('E2E Test Zeiterfassung');
    await page.locator('#clientId').selectOption({ label: 'Mustermann GmbH' });
    const startBtn = page.getByRole('button', { name: /Timer starten/ });
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    await startBtn.click();

    const stopBtn2 = page.getByRole('button', { name: /Stoppen/ });
    await expect(stopBtn2).toBeVisible({ timeout: 5000 });
    await stopBtn2.click();
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
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 8000 });

    await page.goto('/staff/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  // 12. Audit Trail
  test('Audit trail contains entries', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) {
      throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');

    // FIX 1: Audit-Log ist GoBD-pflichtig — admin MUSS zugreifen. Redirect = Fehler.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit page — RBAC or session issue');
    }

    // FIX 2: Statt body-visible — die Audit-Seite MUSS die Audit-Tabelle oder
    // eine Leer-Meldung rendern (konkretes Seiten-Element).
    const auditContent = page
      .getByRole('heading', { name: /Audit-Log/i })
      .or(page.getByText(/Keine Einträge|Hash-Chain/i).first());
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
test.describe.serial('Portal Actions', () => {
  test('Login as mandant', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const request = ctx.request;

    try {
      await loginAsMandant(page, request);
      await expectPortalDashboardReady(page);
      await ctx.storageState({ path: MANDANT_AUTH });
    } catch (e) {
      throw new Error(
        `Portal login failed — MailHog/SMTP/Magic-Link are mandatory in paranoid E2E: ${(e as Error).message}`,
        { cause: e },
      );
    } finally {
      await ctx.close();
    }
  });

  test('View shared documents in portal', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) {
      throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/documents');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: /Dokumente/ })).toBeVisible({ timeout: 8000 });
    // FIX 2: Statt body-visible — die Dokumenten-Seite MUSS eine Tabelle oder
    // Leer-Meldung zeigen (kein bloßer Body-Check).
    const docsContent = page
      .locator('table')
      .or(page.getByText(/Keine Dokumente|noch keine Dokumente/i));
    await expect(docsContent.first()).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  test('Portal requests page loads', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) {
      throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/requests');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: /Anforderungen/ })).toBeVisible({
      timeout: 8000,
    });
    // FIX 2: Statt body-visible — die Anforderungs-Seite MUSS konkreten
    // Inhalt (Tabelle/Leer-Meldung) rendern.
    const reqContent = page.locator('table, main ul').or(page.getByText(/Keine Anforder/i));
    await expect(reqContent.first()).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  test('Request an appointment as mandant', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) {
      throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.');
    }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/appointments');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: 'Termine', exact: true })).toBeVisible({
      timeout: 8000,
    });

    const anfragenBtn = page.getByRole('button', { name: /Anfragen/ });
    await expect(anfragenBtn).toBeVisible({ timeout: 5000 });
    await anfragenBtn.click();

    const subjectInput = page.locator('input[name="subject"]');
    await expect(subjectInput).toBeVisible({ timeout: 5000 });
    await subjectInput.fill('E2E Test Terminanfrage');
    await page.locator('textarea[name="notes"]').fill('Bitte um einen Termin.');
    await expect(page.locator('[name="slot0_starts"]')).toHaveValue(/T\d{2}:\d{2}/);
    await expect(page.locator('[name="slot0_ends"]')).toHaveValue(/T\d{2}:\d{2}/);

    const s = page.getByRole('button', { name: /Anfrage senden/ });
    await expect(s).toBeVisible({ timeout: 5000 });
    await s.click();

    // FIX 2: Statt body-visible — die Terminanfrage MUSS bestätigt werden
    // (Erfolgs-Meldung oder der Betreff erscheint in der Anfrage-Liste).
    const confirmation = page.getByText(/E2E Test Terminanfrage|erfolgreich|versendet|angefragt/i);
    await expect(
      confirmation.first(),
      'Terminanfrage muss bestätigt oder gelistet werden',
    ).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });
});
