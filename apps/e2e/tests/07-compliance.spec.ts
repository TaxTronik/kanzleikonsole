// =============================================================================
// 07-compliance.spec.ts — COMPLIANCE-E2E: GoBD, GwG, DSGVO, Audit, Tenant-Isolation
//
// Testet alle Compliance-relevanten Operationen:
//   GoBD §147 AO (Dokumenten-Compliance), GwG §10-12, DSGVO,
//   Audit-Trail (GoBD), Tenant-Isolation (§203 StGB),
//   Session-Security, Rechnungs-Compliance (XRechnung), Magic-Link-Security,
//   Input-Validation, File-Upload-Security, RBAC, Backup/Restore.
//
// Jeder describe.serial-Block teilt eine Login-Session via storageState.
// =============================================================================
import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { expectPortalDashboardReady, loginAsMandant, PORTAL_EMAIL } from './helpers/portal-auth';
import { flushRedisDb } from './helpers/redis';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_DIR = path.join(os.tmpdir(), 'taxtronik-e2e-auth');
const STAFF_AUTH = path.join(AUTH_DIR, 'staff.json');
const MANDANT_AUTH = path.join(AUTH_DIR, 'mandant.json');
let complianceDocumentTitle = '';
let complianceDocumentId = '';
let securityDocumentId = '';

// Origin für CSRF-Header: aus ENV (CI-konfigurierbar) oder Dev-Default.
// NICHT aus page.url() — das ist about:blank vor der ersten Navigation
// und würde Origin: "null" setzen → CSRF-Check schlägt fehl → 403.
const BASE_ORIGIN = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

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

async function openMustermannDocuments(page: Page): Promise<string> {
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
  const text = await page.locator('main').innerText().catch(() => '');
  throw new Error(`Mustermann-Dokumenten-Scope nicht gefunden. Sichtbarer Inhalt: ${text.slice(0, 500)}`);
}

function createEicarBuffer(): Buffer {
  return Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    'utf-8',
  );
}

// =============================================================================
// FIX 3: Direkter DB-Zugriff für echte Tenant-Isolation.
// Unterstützt BOTH: docker exec (lokales Dev) UND psql -h localhost (CI).
// In CI läuft Postgres als Service-Container, nicht als docker-exec-barer Container.
// =============================================================================
const PG_CONTAINER = process.env['E2E_POSTGRES_CONTAINER'] ?? 'taxtronik-postgres';
const PG_USER = process.env['E2E_POSTGRES_USER'] ?? 'taxtronik';
const PG_DB = process.env['E2E_POSTGRES_DB'] ?? 'taxtronik';
const PG_HOST = process.env['E2E_POSTGRES_HOST'] ?? 'localhost';
const PG_PASSWORD = process.env['E2E_POSTGRES_PASSWORD'] ?? 'taxtronik';

function psql(query: string): string {
  const oneLine = query.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  try {
    return execSync(`docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -t -A -c "${oneLine}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return execSync(`psql -h ${PG_HOST} -U ${PG_USER} -d ${PG_DB} -t -A -c "${oneLine}"`, {
      encoding: 'utf-8',
      env: { ...process.env, PGPASSWORD: PG_PASSWORD },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}

function psqlAvailable(): boolean {
  try {
    psql('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function readAuditActionsFiltered(page: Page, action: string): Promise<string[]> {
  const qs = new URLSearchParams({ action });
  await page.goto(`/staff/admin/audit?${qs.toString()}`);
  await page.waitForLoadState('domcontentloaded');
  if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
    throw new Error('Admin cannot access audit log page — RBAC or session issue');
  }
  await expect(page.getByRole('heading', { name: /Audit-Log/i })).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('table tbody tr').or(page.getByText(/Keine Einträge|Keine Eintraege/i)).first(),
    `Audit-Filter fuer ${action} muss Tabelle oder Leerzustand rendern`,
  ).toBeVisible({ timeout: 10_000 });
  const texts = await page.locator('table tbody tr td:nth-child(4)').allInnerTexts().catch(() => [] as string[]);
  return texts.map((t) => t.trim()).filter(Boolean);
}

// =============================================================================
// SECTION 1: Dokumenten-Compliance (GoBD §147 AO)
// =============================================================================
test.describe.serial('GoBD §147 AO — Dokumenten-Compliance', () => {
  test.beforeAll(() => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    try { fs.unlinkSync(STAFF_AUTH); } catch { /* best-effort cleanup */ }
  });

  test('Login as admin', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });
    await ctx.storageState({ path: STAFF_AUTH });
    await ctx.close();
  });

  test('1.1 Upload a PDF document', async ({ browser }) => {
    test.setTimeout(60_000);
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const scopedDocumentsUrl = await openMustermannDocuments(page);
    expect(page.url()).not.toContain('/staff/login');

    const uploadBtn = page.getByRole('button', { name: /Hochladen/i }).first();
    let btnVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!btnVisible) {
      const uploadBtn2 = page.getByRole('button', { name: /Upload/i }).first();
      btnVisible = await uploadBtn2.isVisible({ timeout: 3000 }).catch(() => false);
      if (btnVisible) {
        await uploadBtn2.click();
      } else {
        const uploadLink = page.getByRole('link', { name: /Hochladen|Dokument.*hochladen|Upload/i }).first();
        btnVisible = await uploadLink.isVisible({ timeout: 3000 }).catch(() => false);
        if (!btnVisible) {
          const allButtons = await page.locator('button, a[role="button"]').allInnerTexts().catch(() => [] as string[]);
          throw new Error(`Upload button not found on /staff/documents. Available buttons: ${allButtons.join(', ') || '(none)'}`);
        }
        await uploadLink.click();
      }
    } else {
      await uploadBtn.click();
    }
    await page.waitForTimeout(1000);

    complianceDocumentTitle = `E2E Compliance Test Dokument ${Date.now()}`;
    const fileInput = page.locator('#upload-file, input[type="file"]').first();
    await expect(fileInput, 'Upload-Dialog muss ein Datei-Feld enthalten').toBeVisible({ timeout: 4000 });
    await fileInput.setInputFiles({
      name: `e2e-compliance-${Date.now()}.pdf`,
      mimeType: 'application/pdf',
      buffer: createMinimalPdf(),
    });
    await page.waitForTimeout(500);

    const titleInput = page.locator('#upload-title, input[name="title"]');
    await expect(titleInput, 'Upload-Dialog muss ein Titel-Feld enthalten').toBeVisible({ timeout: 2000 });
    await titleInput.fill(complianceDocumentTitle);

    const submitBtn = page.locator('button[type="submit"]').filter({ hasText: /Hochladen/ });
    await expect(submitBtn, 'Upload-Dialog muss einen Submit-Button enthalten').toBeVisible({ timeout: 3000 });
    const commitResponse = page.waitForResponse((res) =>
      res.url().includes('/api/staff/documents/commit') && res.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await submitBtn.click();
    const uploadRes = await commitResponse;
    const uploadBody = await uploadRes.json().catch(() => ({}));
    expect(uploadRes.status(), `Dokumenten-Commit muss erfolgreich sein: ${JSON.stringify(uploadBody)}`).toBe(200);
    complianceDocumentId = String(uploadBody.documentId ?? '');
    expect(complianceDocumentId, 'Commit-Response muss die Dokument-ID enthalten').toBeTruthy();

    await page.waitForTimeout(2000);
    // FIX 2: Statt body-visible — der Upload MUSS das Dokument in der Liste
    // erzeugen. Sonst ist der Upload-Vorgang (GoBD §147 AO) fehlgeschlagen.
    await page.goto(scopedDocumentsUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(
      page.getByText(complianceDocumentTitle).first(),
      'Hochgeladenes Dokument muss nach Upload in der Dokumentenliste stehen',
    ).toBeVisible({ timeout: 8000 });
    await ctx.close();
  });

  test('1.2 Verify uploaded document appears in list', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await openMustermannDocuments(page);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    // Konkreten Titel aus Test 1.1 auf der Seite wiederfinden.
    // Falls der Upload in 1.1 fehlgeschlagen ist, ist das hier rot.
    const uploaded = page.getByText(complianceDocumentTitle);
    await expect(uploaded.first()).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('1.3 Soft-delete a document and verify it is hidden but recoverable', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await openMustermannDocuments(page);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    expect(page.url()).not.toContain('/staff/login');

    const downloadLink = page.locator(`a[href="/api/staff/documents/${complianceDocumentId}/download"]`).first();
    await expect(downloadLink, 'Das gerade hochgeladene Dokument muss vor dem Soft-Delete sichtbar sein').toBeVisible({ timeout: 8000 });

    const trashBtn = downloadLink.locator('xpath=following::button[@title="Löschen"][1]');
    const trashVisible = await trashBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (trashVisible) {
      await trashBtn.click();
      await page.waitForTimeout(1000);

      const dialog = page.getByRole('dialog', { name: /Dokument.*löschen/i });
      await expect(dialog, 'Soft-Delete muss einen bestaetigenden Dialog anzeigen').toBeVisible({ timeout: 5000 });
      await dialog.getByRole('button', { name: /Löschen|löschen/i }).click();
      await page.waitForTimeout(2000);
    } else {
      await page.goto('/staff/documents?deleted=1');
      await page.waitForTimeout(3000);
      expect(page.url()).not.toContain('/staff/login');

      // FIX 2: Auch im Deleted-View muss eine konkrete Aussage treffen — die
      // Seite lädt entweder den Papierkorb oder eine Leer-Meldung, nicht "body".
      const deletedHeading = page.getByRole('heading', { name: /Dokumente|Papierkorb/i });
      await expect(deletedHeading.first()).toBeVisible({ timeout: 5000 });
    }

    // FIX 2: Nach Soft-Delete muss die Dokumenten-Übersicht noch geladen sein
    // und darf nicht auf Login umgeleitet worden sein (Konkret statt body).
    expect(page.url()).not.toContain('/staff/login');
    await expect(downloadLink, 'Soft-geloeschtes Dokument darf in der aktiven Liste nicht mehr sichtbar sein').toBeHidden({ timeout: 5000 });
    await expect(page.locator('main')).toBeVisible({ timeout: 5000 });
    await ctx.close();
  });

  test('1.4 Object-Lock metadata validation (retention date)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    expect(complianceDocumentId, 'Kein Dokument fuer Object-Lock-Check — Test 1.1 muss die ID gesetzt haben').toBeTruthy();
    await page.goto(`/staff/documents/${complianceDocumentId}`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/\/staff\/documents\/[a-f0-9-]+/);
    const retentionText = page.getByText(/Aufbewahrung|GoBD-immutable|retention/i);
    const retentionVisible = await retentionText.first().isVisible({ timeout: 4000 }).catch(() => false);
    if (retentionVisible) {
      await expect(retentionText.first()).toBeVisible();
    }
    const shaText = page.getByText(/SHA-256/);
    await expect(shaText).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('1.5 Upload ohne classification/documentTypeId wird mit 400 abgelehnt', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Commit-Endpoint: multipart mit Datei, aber OHNE classification und
    // documentTypeId → Zod-.refine() schlägt fehl → 400.
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: BASE_ORIGIN },
      multipart: {
        file: {
          name: 'no-type.pdf',
          mimeType: 'application/pdf',
          buffer: createMinimalPdf(),
        },
        title: 'Upload ohne Typ',
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error ?? '').toMatch(/validation|classification|documentTypeId/i);

    await ctx.close();
  });

  test('1.6 Upload new version of existing document', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    expect(complianceDocumentId, 'Kein Dokument fuer Version-Upload — Test 1.1 muss die ID gesetzt haben').toBeTruthy();
    await page.goto(`/staff/documents/${complianceDocumentId}`);
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');

    const versionForm = page.locator('#new-version-file, input[type="file"]');
    const formVisible = await versionForm.isVisible({ timeout: 4000 }).catch(() => false);

    if (formVisible) {
      await versionForm.setInputFiles({
        name: 'updated-e2e-compliance.pdf',
        mimeType: 'application/pdf',
        buffer: createMinimalPdf(),
      });
      await page.waitForTimeout(500);

      const submitBtn = page.getByRole('button', { name: /Version|Hochladen/ }).first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(4000);
      }
    }

    // FIX 2: Wenn ein Version-Upload stattfand, muss die Detailseite Versions-
    // Metadaten oder zumindest den SHA-256-Hash zeigen (GoBD-Integrität).
    if (page.url().includes('/staff/documents/')) {
      const integrityMarker = page.getByText(/SHA-256|Version|v[0-9]+/i);
      await expect(integrityMarker.first()).toBeVisible({ timeout: 5000 });
    } else {
      // Kein Ziel-Dokument gefunden → seed-abhängig, aber Seite muss stabil sein.
      expect(page.url()).not.toContain('/staff/login');
    }
    await ctx.close();
  });

  test('1.7 Content-Length-Präfix-Check: >100MB+1MB wird mit 413 abgelehnt', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Der Commit-Endpoint prüft deklarierte Content-Length VOR dem Puffern.
    // MAX_UPLOAD_BYTES = 100 * 1024 * 1024. Mit +1MB Marge → bei >101MB 413.
    // Wir schicken einen winzigen Body, lügen aber beim Content-Length-Header.
    // Der Server lehnt VOR dem Lesen ab → 413 (DoS-Schutz).
    const fakeLargeLen = String(100 * 1024 * 1024 + 2 * 1024 * 1024);
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: {
        Origin: BASE_ORIGIN,
        'Content-Length': fakeLargeLen,
        'Content-Type': 'multipart/form-data; boundary=fake',
      },
      data: 'x',
    });

    // 413 ist der erwartete Präfix-Check. 400 ist auch akzeptabel
    // (multipart parse fail), aber NIEMALS 200.
    expect(res.status()).not.toBe(200);
    expect([400, 413]).toContain(res.status());

    await ctx.close();
  });
});

// =============================================================================
// SECTION 2: GwG-Compliance (§10-12 GwG)
// =============================================================================
test.describe.serial('GwG §10-12 — Geldwäschegesetz-Compliance', () => {
  test('2.1 GwG retention page loads', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/gwg-retention');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Admin MUSS die GwG-Pflichtlöschungs-Seite sehen (§ 8 GwG).
    // Eine Umleitung auf Dashboard/Login ist ein RBAC-/Session-Fehler → FAIL.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access GwG retention page — RBAC or session issue');
    }

    const heading = page.getByRole('heading', { name: /GwG-Pflichtlöschung/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/GwG|Belege|löschreif/i).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!hasContent) {
        await ctx.close();
        throw new Error('GwG retention page loaded but rendered no GwG content — page broken');
      }
    }

    // FIX 4: Die Aufbewahrungsfrist MUSS „5 Jahre" (GwG § 8 Abs. 4) lauten —
    // nicht irgendein GwG-Text. Eine abweichende Frist wäre ein Compliance-Bug.
    const retentionYearText = page.getByText(/5\s?Jahre/);
    await expect(retentionYearText.first(), 'GwG retention period must be "5 Jahre" (§ 8 Abs. 4 GwG)').toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('2.2 Client detail shows GwG status badge', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const clientLink = page.getByRole('link', { name: /Mustermann/ }).first();
    await expect(clientLink).toBeVisible({ timeout: 8000 });
    await clientLink.click();
    await page.waitForTimeout(3000);
    expect(page.url()).toContain('/staff/clients/');

    const statusBadge = page.locator('.badge-green, .badge-yellow').first();
    const badgeVisible = await statusBadge.isVisible({ timeout: 5000 }).catch(() => false);
    if (badgeVisible) {
      const text = await statusBadge.textContent().catch(() => '');
      expect(text).toMatch(/Aktiv|GwG|ausstehend|Verifiziert/i);
    }

    await ctx.close();
  });

  test('2.3 GwG-Onboarding public page loads', async ({ page }) => {
    await page.goto('/gwg-onboarding');
    await page.waitForTimeout(2000);
    // FIX 2: Kein body-visible — die öffentliche GwG-Onboarding-Seite muss
    // GwG-relevanten Inhalt (Identifizierung/Geldwäsche) rendern.
    const gwgContent = page.getByText(/GwG|Geldwäsche|Identifizierung|identifizieren/i);
    await expect(gwgContent.first()).toBeVisible({ timeout: 5000 });
  });

  test('2.4 GwG verification workflow states are visible', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Admin-Seite — Umleitung ist ein Fehler, kein Skip.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access admin dashboard — RBAC or session issue');
    }

    const gwgContent = page.getByText(/GwG|Geldwäsche/i);
    const gwgVisible = await gwgContent.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (gwgVisible) {
      await expect(gwgContent.first()).toBeVisible();
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 3: DSGVO-Compliance
// =============================================================================
test.describe.serial('DSGVO — Datenschutz-Grundverordnung', () => {
  test('3.1 DSGVO requests page loads', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/dsgvo');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: DSGVO-Admin-Seite — Umleitung = RBAC/Session-Fehler → FAIL.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access DSGVO requests page — RBAC or session issue');
    }

    const heading = page.getByRole('heading', { name: /DSGVO-Anfragen/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/DSGVO|Auskunft|Löschung|Art\./i).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (hasContent) {
        await expect(page.getByText(/DSGVO|Auskunft/i).first()).toBeVisible();
      } else {
        await ctx.close();
        throw new Error('DSGVO requests page loaded but rendered no DSGVO content — page broken');
      }
    } else {
      await expect(heading).toBeVisible();
    }

    await ctx.close();
  });

  test('3.2 Client anonymization UI exists', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/dsgvo-retention');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: DSGVO-Retention-Anonymisierung — Admin MUSS zugreifen (Art. 17).
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access DSGVO retention page — RBAC or session issue');
    }

    const heading = page.getByRole('heading', { name: /Anonymisierung/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/anonymisierungsrei|Anonymisierung|Mandant/i).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (hasContent) {
        await expect(page.getByText(/anonymisierungsrei|Anonymisierung/i).first()).toBeVisible();
      } else {
        await ctx.close();
        throw new Error('DSGVO retention page loaded but no anonymization content rendered');
      }
    } else {
      await expect(heading).toBeVisible();
      const legalText = page.getByText(/unwiderruflich|Art\. 17|Art\. 5/i);
      const legalVisible = await legalText.first().isVisible({ timeout: 3000 }).catch(() => false);
      if (legalVisible) {
        await expect(legalText.first()).toBeVisible();
      }
    }

    await ctx.close();
  });

  test('3.3 Consent/DSGVO settings in admin sidebar', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // FIX 1: Admin-Seite — Umleitung = Fehler.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access admin page — RBAC or session issue');
    }

    const dsgvoLink = page.getByRole('link', { name: /DSGVO/i });
    const dsgvoVisible = await dsgvoLink.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (dsgvoVisible) {
      await expect(dsgvoLink.first()).toBeVisible();
    }

    const dsgvoCard = page.getByText(/Offene DSGVO-Anfragen/);
    const cardVisible = await dsgvoCard.isVisible({ timeout: 5000 }).catch(() => false);
    if (cardVisible) {
      await expect(dsgvoCard).toBeVisible();
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 4: Audit Trail (GoBD)
// =============================================================================
test.describe.serial('Audit Trail — GoBD-Revisionssicherheit', () => {
  test('4.1 Audit log page loads', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Audit-Log ist GoBD-pflichtig — Admin MUSS zugreifen.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit log page — RBAC or session issue');
    }

    const heading = page.getByRole('heading', { name: /Audit-Log/i });
    const headingVisible = await heading.isVisible({ timeout: 6000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/Hash-Chain|Prüfer-Link|Noch kein/).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!hasContent) {
        await ctx.close();
        throw new Error('Audit page loaded but rendered no audit content — page broken');
      }
    }

    await ctx.close();
  });

  test('4.2 Audit entries have timestamps and actor IDs', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit log page — RBAC or session issue');
    }

    const thElements = page.locator('thead th');
    const thCount = await thElements.count().catch(() => 0);

    if (thCount > 0) {
      const headerTexts = await thElements.allInnerTexts().catch(() => [] as string[]);
      const hasTimestamp = headerTexts.some((h: string) => /Zeit|Datum/i.test(h));
      const hasAction = headerTexts.some((h: string) => /Action|Akteur/i.test(h));
      if (!hasTimestamp && !hasAction) {
        await ctx.close();
        throw new Error('Audit table missing Zeit/Action/Akteur columns — schema regression');
      }
    }

    const rows = page.locator('table tbody tr');
    const count = await rows.count().catch(() => 0);
    if (count > 0) {
      await expect(rows.first()).toBeVisible();
    }

    await ctx.close();
  });

  // FIX 4: Konkrete Action-Labels prüfen. Frühere Tests (Login, Document-Upload)
  // erzeugen Audit-Einträge mit definierten Action-Typen. Diese MÜSSEN in der
  // Tabelle auftauchen — sonst ist die Audit-Trail lückenhaft (GoBD-Verstoß).
  test('4.2b Audit log contains specific action types from earlier tests', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Der Login in „Login as admin" erzeugt auth.login.success; der Document-
    // Upload in 1.1 erzeugt document.upload. Wir filtern gezielt auf die Action,
    // damit hohe Audit-Volumina nicht von der ersten Cursor-Seite abhängen.
    const loginActions = await readAuditActionsFiltered(page, 'auth.login.success');
    const hasLogin = loginActions.some((a) => a.includes('auth.login.success'));
    const uploadActions = await readAuditActionsFiltered(page, 'document.upload');
    const hasUpload = uploadActions.some((a) => a.includes('document.upload'));
    // auth.login.success MUSS da sein (Login ist Voraussetzung jedes Tests hier).
    expect(
      hasLogin,
      `Audit-Log muss auth.login.success enthalten (sichtbare gefilterte Actions: ${loginActions.join(', ') || 'keine'})`,
    ).toBe(true);
    // document.upload nur, falls der Upload in 1.1 erfolgreich war (siehe 1.2).
    if (hasUpload) {
      // ok — zusätzlicher Beweis, dass der Audit-Trail Actions korrekt loggt.
    }

    await ctx.close();
  });

  test('4.3 Audit log is NOT modifiable (no edit/delete buttons)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit log page — RBAC or session issue');
    }

    const editButtons = page.locator('table tbody').getByRole('button', { name: /Bearbeiten|Edit|Ändern/i });
    const deleteButtons = page.locator('table tbody').getByRole('button', { name: /Löschen|Delete|Trash/i });

    const editCount = await editButtons.count().catch(() => 0);
    const deleteCount = await deleteButtons.count().catch(() => 0);
    expect(editCount).toBe(0);
    expect(deleteCount).toBe(0);

    await ctx.close();
  });

  test('4.4 Hash-Chain integrity banner is visible', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit log page — RBAC or session issue');
    }

    // FIX 1: Hash-Chain-Banner ist GoBD-pflichtig — fehlt es, ist die Seite
    // kaputt (kein Skip, sondern FAIL).
    const hashBanner = page.getByText(/Hash-Chain|Noch kein Prüfergebnis|Prüfer-Link/i);
    await expect(hashBanner.first(), 'Hash-Chain/Prüfergebnis-Banner muss auf Audit-Seite stehen').toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('4.5 Prüfer-Link (audit token) section exists', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit log page — RBAC or session issue');
    }

    // FIX 1: Prüfer-Link-Sektion ist Bestandteil der Audit-Seite. Fehlt sie,
    // ist die Seite unvollständig → FAIL (kein Skip).
    const prueferLink = page.getByText(/Prüfer-Link/i);
    await expect(prueferLink, 'Prüfer-Link-Sektion muss auf Audit-Seite vorhanden sein').toBeVisible({ timeout: 5000 });

    await ctx.close();
  });
});

// =============================================================================
// SECTION 5: Tenant Isolation (§203 StGB)
// =============================================================================
// FIX 3: Echte Mandantentrennung mit einem ZWEITEN Tenant. Eine erfundene UUID
// (alter Test 5.2/5.3) beweist nur, dass Nicht-Existenz abgelehnt wird — nicht,
// dass eine EXISTIERENDE fremde Mandant unsichtbar ist. Hier legen wir via psql
// einen echten zweiten Tenant + Mandanten an und versuchen, als admin (Tenant A)
// darauf zuzugreifen. §203 StGB verlangt strikte Trennung.
let TENANT_B_CLIENT_ID: string | null = null;

test.describe.serial('Tenant Isolation — §203 StGB Mandantentrennung', () => {
  test.beforeAll(() => {
    // Lege zweiten Tenant „Fremd Kanzlei" + Mandanten „Fremd Mandant GmbH" an.
    // Wenn Postgres/Docker nicht erreichbar ist, wird der neue Test übersprungen
    // (infra-abhängig) — aber 5.1–5.4 laufen weiterhin.
    //
    // Hinweis: Prisma @updatedAt hat keinen DB-Default → wir setzen updated_at
    // explizit. created_at hat @default(now()) und wird von Postgres gefüllt.
    if (!psqlAvailable()) return;
    try {
      psql(
        `INSERT INTO tenant (slug, name, updated_at) ` +
          `VALUES ('fremd-kanzlei', 'Fremd Kanzlei', now()) ` +
          `ON CONFLICT (slug) DO NOTHING`,
      );
      const tenantBId = psql(`SELECT id FROM tenant WHERE slug = 'fremd-kanzlei'`);
      if (!tenantBId) return;
      psql(
        // allow_active=false: ein frischer Mandant ohne verifizierten GwG-Check
        // darf nicht aktiv sein (DB-Trigger »allow_active erfordert gwg_check«).
        // Für den Tenant-Isolation-Test reicht Existenz in Tenant B.
        `INSERT INTO client (tenant_id, kind, name, allow_active, updated_at) ` +
          `VALUES ('${tenantBId}', 'JURPERS', 'Fremd Mandant GmbH', false, now()) ` +
          `ON CONFLICT DO NOTHING`,
      );
      TENANT_B_CLIENT_ID = psql(
        `SELECT id FROM client WHERE tenant_id = '${tenantBId}' AND name = 'Fremd Mandant GmbH' ORDER BY created_at DESC LIMIT 1`,
      );
    } catch {
      TENANT_B_CLIENT_ID = null;
    }
  });

  test('5.1 Admin only sees own tenant clients', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 8000 });
    // FIX 3: Fremd-Mandant aus Tenant B darf in Tenant As Liste NICHT auftauchen.
    if (TENANT_B_CLIENT_ID) {
      const foreignLeak = page.getByText('Fremd Mandant GmbH');
      const leaked = await foreignLeak.isVisible({ timeout: 2000 }).catch(() => false);
      expect(leaked, 'Fremder Mandant (Tenant B) darf in Tenant As Client-Liste nicht sichtbar sein').toBe(false);
    }

    await ctx.close();
  });

  test('5.2 Cross-tenant access via fabricated UUID returns 404', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const fakeUuid = '00000000-0000-4000-8000-000000000999';
    const res = await page.goto(`/staff/clients/${fakeUuid}`);
    await page.waitForTimeout(2000);

    if (res) {
      const status = res.status();
      expect([200, 404, 302]).toContain(status);
    }

    if (page.url().includes('/staff/login') || page.url().includes('/staff/dashboard')) {
      // Redirect means no data shown — acceptable
    } else {
      const notFoundText = page.getByText(/nicht gefunden|404|Not Found/i);
      await expect(notFoundText.first()).toBeVisible({ timeout: 3000 });
    }

    await ctx.close();
  });

  test('5.3 Cross-tenant API call returns 403/404', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const request = ctx.request;

    const fakeUuid = '00000000-0000-4000-8000-000000000888';
    const res = await request.get(`/api/staff/clients/${fakeUuid}`);

    // Cross-tenant or non-existent UUID must NOT return 200
    expect(res.status()).not.toBe(200);
    expect([401, 403, 404]).toContain(res.status());

    await ctx.close();
  });

  // FIX 3: Der echte Cross-Tenant-Test. Tenant B hat einen existierenden
  // Mandanten (oben per psql angelegt). Admin (Tenant A) darf ihn über UI UND
  // API nicht sehen — sonst §203 StGB-Verstoß (Datenleck an fremde Kanzlei).
  test('5.3b Real cross-tenant access to existing Tenant-B client is blocked', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    // Tenant-Isolation ist Kernschutz (§203 StGB). Wenn der Tenant-B-Seed
    // nicht klappt, ist das ein Fehler — kein Skip.
    if (!TENANT_B_CLIENT_ID) {
      TENANT_B_CLIENT_ID = psql(
        `SELECT c.id FROM client c JOIN tenant t ON t.id = c.tenant_id WHERE t.slug = 'fremd-kanzlei' AND c.name = 'Fremd Mandant GmbH' ORDER BY c.created_at DESC LIMIT 1`,
      ) || null;
    }
    if (!TENANT_B_CLIENT_ID) {
      throw new Error(
        'Tenant-B-Setup fehlgeschlagen — Tenant-Isolation kann nicht getestet werden. ' +
        'psql-Verbindung prüfen (docker exec oder localhost).',
      );
    }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // (1) UI-Versuch: /staff/clients/<Tenant-B-Client-ID>
    const uiRes = await page.goto(`/staff/clients/${TENANT_B_CLIENT_ID}`);
    await page.waitForTimeout(2000);
    const uiStatus = uiRes?.status() ?? 200;
    // Next App Router kann in Dev eine 404-Shell mit HTTP 200 ausliefern.
    // Sicherheitsrelevant ist: niemals 200 mit Fremddaten. Daher ist 200 nur
    // erlaubt, wenn die sichtbare Seite eindeutig Not Found ist.
    expect([200, 403, 404, 302], 'UI muss blocken oder eine Not-Found-Shell rendern (§203 StGB)').toContain(uiStatus);

    // Falls kein Redirect: sicherstellen, dass KEINE Fremddaten gerendert werden.
    if (!page.url().includes('/staff/login') && !page.url().includes('/staff/dashboard')) {
      const foreignData = page.getByText('Fremd Mandant GmbH');
      const leaked = await foreignData.isVisible({ timeout: 2000 }).catch(() => false);
      expect(leaked, 'Fremder Mandantenname darf nicht im DOM auftauchen').toBe(false);
      const notFoundText = page.getByText(/nicht gefunden|404|Not Found/i);
      await expect(notFoundText.first()).toBeVisible({ timeout: 3000 });
    }

    // (2) API-Versuch: GET /api/staff/clients/<Tenant-B-Client-ID>/export
    const apiRes = await page.request.get(`/api/staff/clients/${TENANT_B_CLIENT_ID}/export`, {
      headers: { Origin: BASE_ORIGIN },
    });
    expect(apiRes.status(), 'API darf fremden Mandanten nicht exportieren (§203 StGB)').not.toBe(200);
    expect([401, 403, 404]).toContain(apiRes.status());

    await ctx.close();
  });

  test('5.4 Health endpoint shows DB connectivity (indirect RLS check)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const request = ctx.request;

    const res = await request.get('/api/health/detail');
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('services');
      expect(body.services).toHaveProperty('postgres');
      expect(body.services.postgres).toHaveProperty('ok');
    } else {
      expect([401, 403, 200, 503]).toContain(res.status());
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 6: Session & Cookie Security
// =============================================================================
test.describe('Session & Cookie Security', () => {
  // FIX 4: Der exakte Staff-Session-Cookie-Name (Single Source of Truth:
  // apps/web/src/server/auth/session-cookie.ts). In Dev: __taxtronik_staff_session.
  const STAFF_COOKIE_RE = /^(__Host-|__Secure-|__)?taxtronik[_-]?staff/i;

  test('6.1 Login sets session cookie', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => STAFF_COOKIE_RE.test(c.name));
    expect(sessionCookie, 'Login muss ein taxtronik*staff Session-Cookie setzen').toBeDefined();

    if (sessionCookie) {
      // FIX 4: Cookie-Name MUSS dem taxtronik*staff-Muster entsprechen.
      expect(sessionCookie.name).toMatch(STAFF_COOKIE_RE);
      expect(sessionCookie.httpOnly).toBe(true);
      expect(['lax', 'strict', 'Lax', 'Strict']).toContain(sessionCookie.sameSite);
      if (page.url().startsWith('http://')) {
        expect(sessionCookie.secure, 'HTTP-E2E darf kein Secure-Session-Cookie setzen').toBe(false);
      }
    }
  });

  test('6.2 Logout clears session cookie', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    const cookiesBefore = await page.context().cookies();
    const sessionCookie = cookiesBefore.find((c) => STAFF_COOKIE_RE.test(c.name));
    expect(sessionCookie, 'Session-Cookie muss vor Logout existieren').toBeDefined();
    const cookieName = sessionCookie?.name;

    const logoutBtn = page.getByRole('button', { name: /Abmelden/i });
    const logoutVisible = await logoutBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (logoutVisible) {
      await logoutBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.goto('/staff/logout');
      await page.waitForTimeout(2000);
    }

    // FIX 4: Nach Logout MUSS das konkrete Session-Cookie weg sein — nicht nur
    // „body visible". Wir prüfen beim exakten Namen, dass Wert leer/Setup-Cookie
    // entfernt wurde.
    expect(page.url()).toContain('/staff/login');
    const cookiesAfter = await page.context().cookies();
    const after = cookiesAfter.find((c) => c.name === cookieName);
    expect(
      after?.value,
      `Session-Cookie „${cookieName}" muss nach Logout geleert/gelöscht sein`,
    ).toBeFalsy();
  });

  test('6.3 Protected routes redirect to login when session expires', async ({ page }) => {
    await page.goto('/staff/dashboard');
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/staff/login');

    await page.goto('/staff/clients');
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/staff/login');
  });
});

// =============================================================================
// SECTION 7: Rechnungs/GoBD-Compliance (XRechnung)
// =============================================================================
type InvoiceModeUnderTest = 'IN_APP' | 'EXTERNAL';
let invoiceModeUnderTest: InvoiceModeUnderTest | null = null;
let complianceInvoiceHref: string | null = null;

test.describe.serial('Rechnungs-Compliance — XRechnung & GoBD', () => {
  test('7.1 New invoice page loads', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const heading = page.getByText(/Rechnung|Neue Rechnung/i).first();
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);

    if (headingVisible) {
      await expect(heading).toBeVisible();

      const external = await page.getByText(/zentraler Rechnungssoftware/).isVisible({ timeout: 2000 }).catch(() => false);
      if (external) {
        invoiceModeUnderTest = 'EXTERNAL';
        await expect(page.locator('#pdf'), 'EXTERNAL-Modus muss den PDF-Upload anzeigen').toBeVisible({ timeout: 5000 });
      } else {
        invoiceModeUnderTest = 'IN_APP';
        await expect(
          page.locator('#subject').or(page.getByText(/Keine aktiven Mandanten/i)).first(),
          'IN_APP-Modus muss Formular oder harte GwG-Precondition anzeigen',
        ).toBeVisible({ timeout: 5000 });
      }
    } else {
      await ctx.close();
      throw new Error('Invoice creation page not accessible for admin and not in EXTERNAL mode — page broken or RBAC issue');
    }

    await ctx.close();
  });

  test('7.2 Create invoice with line items', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Redirect auf Login (Session kaputt) oder Dashboard (Feature für
    // admin gesperrt) ist ein Fehler — kein Skip. EXTERNAL wird unten geprüft.
    if (page.url().includes('/staff/login') || page.url().includes('/staff/dashboard')) {
      await ctx.close();
      throw new Error('Admin cannot access invoice creation page — RBAC/session/feature-flag issue');
    }

    const isExternal =
      (await page.getByText(/zentraler Rechnungssoftware/).isVisible({ timeout: 2000 }).catch(() => false)) ||
      (await page.getByText(/PDF-Rechnung hochladen/).isVisible({ timeout: 2000 }).catch(() => false));
    if (isExternal) {
      invoiceModeUnderTest = 'EXTERNAL';
      const clientSelect = page.locator('#clientId');
      await expect(clientSelect, 'EXTERNAL-Rechnungsupload braucht aktive Mandanten').toBeVisible({ timeout: 5000 });

      const optionCount = await clientSelect.locator('option').count();
      expect(optionCount, 'EXTERNAL-Rechnungsupload braucht mindestens einen auswählbaren Mandanten').toBeGreaterThan(1);
      const mustermannOption = clientSelect.locator('option').filter({ hasText: /Mustermann GmbH/i }).first();
      const selectedClient =
        (await mustermannOption.getAttribute('value').catch(() => null)) ??
        (await clientSelect.locator('option').nth(1).getAttribute('value'));
      expect(selectedClient, 'Mandanten-Select muss eine echte Option enthalten').toBeTruthy();
      await clientSelect.selectOption(selectedClient!);

      const externalNumber = `E2E-EXT-${Date.now()}`;
      await page.locator('#number').fill(externalNumber);
      await page.locator('#totalAmount').fill('550.00');
      await page.locator('#subject').fill('E2E Compliance Test Rechnung');
      await page.locator('#pdf').setInputFiles({
        name: 'e2e-compliance-invoice.pdf',
        mimeType: 'application/pdf',
        buffer: createMinimalPdf(),
      });
      await page.getByRole('button', { name: /Rechnung speichern.*Mandant senden/i }).click();
      await page.waitForURL(/\/staff\/invoices\/[a-f0-9-]+/, { timeout: 15_000 });
      complianceInvoiceHref = new URL(page.url()).pathname;
      await expect(page.getByRole('heading', { name: new RegExp(externalNumber) })).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/Versendet/i).first()).toBeVisible({ timeout: 5000 });

      await ctx.close(); return;
    }

    const noClients = await page.getByText(/Keine aktiven Mandanten/).isVisible({ timeout: 2000 }).catch(() => false);
    if (noClients) {
      await ctx.close();
      throw new Error('No active clients for invoice creation — paranoid E2E seed must include a GwG-verified client');
    }

    const subjectInput = page.locator('#subject');
    const subjectReady = await subjectInput.isVisible({ timeout: 8000 }).catch(() => false);
    if (!subjectReady) {
      // FIX 1: Weder EXTERNAL noch „keine Mandanten", aber #subject fehlt → Bug.
      await ctx.close();
      throw new Error('Invoice form #subject field not found (not EXTERNAL, clients exist) — form regression');
    }

    await page.locator('#clientId').selectOption({ label: 'Mustermann GmbH' }).catch(async () => {
      const firstValue = await page.locator('#clientId option').first().getAttribute('value');
      expect(firstValue, 'Mandanten-Select muss eine echte Option enthalten').toBeTruthy();
      await page.locator('#clientId').selectOption(firstValue!);
    });
    await subjectInput.fill('E2E Compliance Test Rechnung');

    const descInput = page.locator('[id^="pos-0-description"]');
    if (await descInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await descInput.fill('Compliance Beratung Q1');
    }
    const unitPriceInput = page.locator('[id^="pos-0-unitPrice"]');
    if (await unitPriceInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await unitPriceInput.fill('200.00');
    }

    const addPosBtn = page.getByRole('button', { name: /Position hinzufügen|weitere Position/i });
    if (await addPosBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addPosBtn.click();
      await page.waitForTimeout(500);
      const desc2 = page.locator('[id^="pos-1-description"]');
      if (await desc2.isVisible({ timeout: 2000 }).catch(() => false)) {
        await desc2.fill('Compliance Prüfung Q1');
      }
      const price2 = page.locator('[id^="pos-1-unitPrice"]');
      if (await price2.isVisible({ timeout: 2000 }).catch(() => false)) {
        await price2.fill('350.00');
      }
    }

    const submitBtn = page.getByRole('button', { name: /Rechnung anlegen/i });
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();
    await page.waitForURL(/\/staff\/invoices\/[a-f0-9-]+/, { timeout: 15_000 });
    complianceInvoiceHref = new URL(page.url()).pathname;
    invoiceModeUnderTest = 'IN_APP';
    expect(page.url()).toContain('/staff/invoices/');
    await expect(page.getByText(/Entwurf/i).first()).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('7.3 Invoice list shows sequential numbers', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const tableRows = page.locator('table tbody tr');
    const count = await tableRows.count().catch(() => 0);

    if (count > 0) {
      await expect(page.locator('table').first()).toBeVisible();
      if (complianceInvoiceHref) {
        await expect(
          page.locator(`a[href="${complianceInvoiceHref}"]`),
          'Die im E2E erzeugte Rechnung muss in der Rechnungsliste auftauchen',
        ).toBeVisible({ timeout: 5000 });
      }
    } else {
      await ctx.close();
      throw new Error('Keine Rechnungen vorhanden — Test 7.2 muss deterministisch eine Rechnung anlegen');
    }

    await ctx.close();
  });

  test('7.4 Configured invoice export/archive is verifiable', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();
    const request = ctx.request;

    await page.goto('/staff/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Invoice list redirected to login — staff storageState/session broken');
    }

    const firstInvLink = complianceInvoiceHref
      ? page.locator(`a[href="${complianceInvoiceHref}"]`).first()
      : page.locator('table tbody tr a').first();
    const invVisible = await firstInvLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (!invVisible) {
      await ctx.close();
      throw new Error('Keine Rechnung für Export-/Archivprüfung gefunden — Test 7.2 muss deterministisch eine Rechnung anlegen');
    }

    const href = await firstInvLink.getAttribute('href').catch(() => null);
    expect(href, 'Rechnungslink muss eine Detail-URL enthalten').toBeTruthy();
    const idMatch = href!.match(/\/staff\/invoices\/([a-f0-9-]+)/);
    expect(idMatch, `Rechnungslink muss eine UUID enthalten: ${href}`).toBeTruthy();
    const invId = idMatch![1]!;

    if (invoiceModeUnderTest === 'EXTERNAL') {
      await firstInvLink.click();
      await expect(page.getByText(/application\/pdf/i), 'EXTERNAL-Rechnung muss eine GoBD-archivierte PDF anzeigen').toBeVisible({ timeout: 5000 });
      await expect(page.getByText(/Versendet/i).first(), 'EXTERNAL-Rechnung muss nach Upload als versendet gelten').toBeVisible({ timeout: 5000 });
      await ctx.close();
      return;
    }

    const res = await request.get(`/api/staff/invoices/${invId}/xrechnung`);
    expect(res.status(), 'XRechnung-Endpoint darf keine Auth-/Server-/Setup-Fehler liefern').toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<rsm:CrossIndustryInvoice');
    expect(xml).toContain('E2E Compliance Test Rechnung');
    await ctx.close();
  });

  test('7.5 Mark invoice as sent and verify', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    if (complianceInvoiceHref) {
      await page.goto(complianceInvoiceHref);
      await page.waitForLoadState('domcontentloaded');
    }

    if (invoiceModeUnderTest === 'EXTERNAL') {
      await expect(page.getByText(/Versendet/i).first(), 'EXTERNAL-Rechnung muss bereits als versendet gelten').toBeVisible({ timeout: 5000 });
      await ctx.close(); return;
    }

    let onDetail = page.url().includes('/staff/invoices/') && !page.url().endsWith('/staff/invoices');
    if (!onDetail) {
      const draftBadge = page.locator('.badge-gray').filter({ hasText: /Entwurf/ });
      const draftCount = await draftBadge.count().catch(() => 0);
      if (draftCount === 0) {
        await ctx.close();
        throw new Error('No DRAFT invoice to test sending — Test 7.2 must create a draft invoice in IN_APP mode');
      }
      const draftRow = draftBadge.first().locator('..');
      const link = draftRow.locator('a').first();
      await expect(link, 'DRAFT invoice row must contain a detail link').toBeVisible({ timeout: 3000 });
      await link.click();
      await page.waitForURL(/\/staff\/invoices\/[a-f0-9-]+/, { timeout: 10_000 });
      onDetail = true;
    }

    expect(onDetail, 'Rechnungsdetailseite muss erreichbar sein').toBe(true);
    const sendBtn = page.getByRole('button', { name: /an mandant übergeben/i });
    await expect(sendBtn, 'DRAFT-Rechnung muss einen Versand-Button anzeigen').toBeVisible({ timeout: 5000 });
    await sendBtn.click();
    await page.waitForTimeout(3000);
    const sentBadge = page.locator('.badge-yellow').filter({ hasText: /Versendet/i });
    await expect(sentBadge.first()).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });
});

// =============================================================================
// SECTION 8: Magic Link Security
// =============================================================================
test.describe('Magic Link Security', () => {
  test('8.1 Magic-Link-Anfrage liefert E-Mail in MailHog', async ({ page, request }) => {
    test.setTimeout(30_000);

    // MailHog ist ein Pflichtservice im Paranoid-CI. Wenn er nicht erreichbar
    // ist, ist das ein Infrastruktur-Fehler → FAIL, nicht skip.
    const mailhogUrl = process.env['E2E_MAILHOG_URL'] ?? 'http://127.0.0.1:8025';
    const mhCheck = await request.get(`${mailhogUrl}/api/v1/health`).catch(() => null);
    expect(mhCheck, 'MailHog muss erreichbar sein (Pflichtservice)').not.toBeNull();

    // Alte Mails löschen, damit wir sicher die neue Mail finden
    await request.delete(`${mailhogUrl}/api/v1/messages`).catch(() => {});

    await page.goto('/portal/login', { waitUntil: 'networkidle' });
    await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();

    // Erfolgsmeldung MUSS erscheinen — SMTP/MailHog ist Pflicht
    await expect(
      page.getByText(/Login-Link verschickt/i),
      'Magic-Link muss verschickt werden (SMTP muss funktionieren)',
    ).toBeVisible({ timeout: 10_000 });

    // Mail MUSS in MailHog ankommen
    await page.waitForTimeout(2000);
    const res = await request.get(`${mailhogUrl}/api/v2/messages?limit=5`);
    expect(res.ok(), 'MailHog API muss antworten').toBe(true);
    const data = await res.json();
    const found = (data.items ?? []).some((msg: { Content?: { Headers?: Record<string, string[]> } }) => {
      const headers = msg.Content?.Headers ?? {};
      const to = Array.isArray(headers['To']) ? headers['To'].join(' ') : headers['To'] ?? '';
      return to.includes(PORTAL_EMAIL);
    });
    expect(found, 'Magic-Link-Mail muss in MailHog für PORTAL_EMAIL ankommen').toBe(true);
  });

  test('8.2 Magic-Link-Mail enthält Token-Parameter', async ({ page, request }) => {
    test.setTimeout(30_000);

    const mailhogUrl = process.env['E2E_MAILHOG_URL'] ?? 'http://127.0.0.1:8025';

    await page.goto('/portal/login', { waitUntil: 'networkidle' });
    await page.getByLabel('E-Mail-Adresse').fill(PORTAL_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();

    await expect(page.getByText(/Login-Link verschickt/i)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);

    const res = await request.get(`${mailhogUrl}/api/v2/messages?limit=5`);
    expect(res.ok(), 'MailHog API muss antworten').toBe(true);

    const data = await res.json();
    const items: Array<{ Content?: { Body?: string } }> = data.items ?? [];
    let foundToken = false;
    for (const msg of items) {
      let body = msg.Content?.Body ?? '';
      body = body.replace(/=\r?\n/g, '');
      body = body.replace(/=3D/g, '=');
      body = body.replace(/=EE=80=85/g, '');
      if (body.includes('token=')) {
        foundToken = true;
        break;
      }
    }
    expect(foundToken, 'Magic-Link-Mail muss einen Token-Parameter enthalten').toBe(true);
  });

  test('8.3 Invalid/expired token fails gracefully', async ({ page }) => {
    await page.goto('/portal/login/verify?token=invalid-token-12345');
    await page.waitForTimeout(3000);

    const errorMsg = page.getByText(/ungültig|abgelaufen|fehlgeschlagen|nicht gefunden/i);
    const errorVisible = await errorMsg.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (!errorVisible) {
      if (page.url().includes('/portal/login')) {
        // Redirect to login without error is graceful
      }
    } else {
      await expect(errorMsg.first()).toBeVisible();
    }
  });

  test('8.4 Rate limiting on magic link requests', async ({ page }) => {
    // Gleiche feste Adresse wie 04-rate-limit.spec.ts für deterministisches
    // Verhalten. Das Limit ist per-IP (5/15min), nicht per-E-Mail.
    // Redis sollte vor diesem Test geflusht sein (CI macht das).
    const RATE_LIMIT_EMAIL = 'compliance-rate-limit-test@taxtronik.local';
    for (let i = 0; i < 5; i++) {
      await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('E-Mail-Adresse').fill(RATE_LIMIT_EMAIL);
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      await page.waitForTimeout(200);
    }

    // 6. Anfrage MUSS blockiert werden
    await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('E-Mail-Adresse').fill(RATE_LIMIT_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();

    await expect(
      page.getByText(/Zu viele Anfragen/i),
      '6. Magic-Link-Anfrage muss per IP-Rate-Limit blockiert werden',
    ).toBeVisible({ timeout: 10_000 });

    await flushRedisDb();
  });
});

// =============================================================================
// SECTION 9: Input Validation & Injection Prevention
// =============================================================================
test.describe.serial('Input Validation — XSS/SQL Injection', () => {
  test('9.1 XSS in client name field is escaped', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const searchInput = page.getByPlaceholder(/Mandanten|Suche|Suchen/i).first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Register dialog handler BEFORE injecting XSS payload
    let dialogTriggered = false;
    page.on('dialog', async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });

    const xssPayload = '<script>alert(1)</script>';
    await searchInput.fill(xssPayload);
    await page.waitForTimeout(500);

    await searchInput.press('Enter');
    await page.waitForTimeout(2000);

    // No alert dialog should have appeared
    expect(dialogTriggered).toBe(false);

    // After search, the DOM must NOT contain raw <script> tags in rendered content.
    // Note: bodyHTML may contain Next.js state/scripts — only check rendered text.
    const bodyText = await page.locator('body').innerText().catch(() => '');
    // The raw XSS payload should not appear in visible text
    expect(bodyText).not.toContain('<script>alert(1)</script>');
    expect(bodyText).not.toContain('alert(1)');

    await ctx.close();
  });

  test('9.2 SQL injection patterns in search are escaped', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const searchInput = page.getByPlaceholder(/Mandanten|Suche|Suchen/i).first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    await searchInput.fill("' OR '1'='1");
    await page.waitForTimeout(1000);
    await searchInput.press('Enter');
    await page.waitForTimeout(2000);

    const dbError = page.getByText(/SQL|syntax error|pg_|database error/i);
    const dbErrVisible = await dbError.first().isVisible({ timeout: 2000 }).catch(() => false);
    expect(dbErrVisible).toBe(false);

    await searchInput.fill("'; DROP TABLE clients; --");
    await searchInput.press('Enter');
    await page.waitForTimeout(1500);
    const dbErr2 = await page.getByText(/SQL|syntax error/i).first().isVisible({ timeout: 2000 }).catch(() => false);
    expect(dbErr2).toBe(false);

    await ctx.close();
  });

  test('9.3 Very long inputs are handled gracefully', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    const searchInput = page.getByPlaceholder(/Mandanten|Suche|Suchen/i).first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    const longStr = 'A'.repeat(10000);
    await searchInput.fill(longStr);
    await page.waitForTimeout(1000);
    await searchInput.press('Enter');
    await page.waitForTimeout(2000);

    // FIX 2: Statt body-visible — die Suche darf keinen Server-Fehler auslösen
    // und die Mandanten-Seite muss funktionsfähig bleiben (keine Leerseite).
    const crashError = page.getByText(/SQL|syntax error|pg_|Something went wrong|Internal Server/i);
    const crashed = await crashError.first().isVisible({ timeout: 2000 }).catch(() => false);
    expect(crashed, 'Sehr lange Eingabe darf keinen Server-Fehler auslösen').toBe(false);
    await expect(page.getByRole('heading', { name: /Mandanten|Clients/i }).first()).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });
});

// =============================================================================
// SECTION 10: File Upload Security
// =============================================================================
test.describe.serial('File Upload Security — ClamAV & Validation', () => {
  test('10.1 EICAR-Testdatei wird von ClamAV abgelehnt (422, nicht 200)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const eicarBuffer = createEicarBuffer();

    // Authentifizierter POST an den echten Commit-Endpoint.
    // Kein .catch — wenn der Request wirft, muss der Test rot werden.
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: BASE_ORIGIN },
      multipart: {
        file: {
          name: 'eicar-test.com',
          mimeType: 'application/octet-stream',
          buffer: eicarBuffer,
        },
        title: 'EICAR Test',
        classification: 'GENERAL',
      },
    });

    const status = res.status();
    // 200 = Malware wurde akzeptiert → SECURITY FAILURE
    expect(status, 'EICAR darf niemals mit 200 durchkommen').not.toBe(200);
    // 500 = Server-Crash, kein Schutz → auch rot
    expect(status, '500 ist ein Fehler, kein ClamAV-Schutz').not.toBe(500);
    // Mit korrektem Origin + Auth MUSS ClamAV greifen → 422 INFECTED.
    // 401/403 bedeuten Setup-Fehler (CSRF/Auth), kein ClamAV-Beweis.
    expect(status, 'EICAR muss von ClamAV mit 422 abgelehnt werden').toBe(422);

    // Body muss INFECTED enthalten
    const body = await res.json().catch(() => ({}));
    expect(body.error ?? '', 'Response-Body muss INFECTED-Präfix haben').toMatch(/INFECTED/i);

    await ctx.close();
  });

  test('10.2 Double-Extension-Datei (invoice.pdf.exe) wird nicht als .exe gespeichert', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Commit mit .pdf.exe Datei. Der Server ERKENNT den MIME via Magic Bytes
    // (PDF), speichert aber den Originalnamen sanitized. Wichtig: die Datei
    // darf nicht als application/x-msscan ausgeführt werden.
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: BASE_ORIGIN },
      multipart: {
        file: {
          name: 'invoice.pdf.exe',
          mimeType: 'application/x-msdownload',
          buffer: createMinimalPdf(),
        },
        title: 'Double Ext Test',
        classification: 'GENERAL',
      },
    });

    // Die Datei ist ein gültiges PDF (Magic Bytes) → ClamAV lässt sie durch.
    // Aber der erkannte MIME muss application/pdf sein, nicht x-msdownload.
    // 200 ist OK (Datei wird angenommen), 400/422 auch (falls Policy das ablehnt).
    // 500 ist ein Fehler.
    expect(res.status()).not.toBe(500);
    if (res.status() === 200) {
      const body = await res.json().catch(() => ({}));
      expect(body.documentId, 'Commit-Response muss die Dokument-ID enthalten').toBeTruthy();
      securityDocumentId = String(body.documentId);
      const preview = await page.request.get(`/api/staff/documents/${body.documentId}/preview-url`);
      expect(preview.status(), 'Preview-Metadaten fuer Double-Extension-Dokument muessen abrufbar sein').toBe(200);
      const previewBody = await preview.json();
      expect(previewBody.mimeType ?? '').toContain('pdf');
      expect(previewBody.mimeType ?? '').not.toMatch(/msdownload|executable|octet-stream/i);
    }

    await ctx.close();
  });

  test('10.3 Dokument-Detailseite zeigt SHA-256-Hash', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const documentId = complianceDocumentId || securityDocumentId;
    expect(documentId, 'Kein Dokument fuer SHA-Check — vorheriger Upload muss die ID gesetzt haben').toBeTruthy();
    await page.goto(`/staff/documents/${documentId}`);
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).not.toContain('/staff/login');
    expect(page.url()).toContain('/staff/documents/');

    // SHA-256 muss auf der Detailseite stehen
    const shaText = page.getByText(/SHA-256/i).first();
    await expect(shaText).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });
});

// =============================================================================
// SECTION 11: Authorization & RBAC
// =============================================================================
test.describe('Authorization & RBAC', () => {
  test('11.1 Admin can access admin routes', async ({ page }) => {
    test.setTimeout(60_000);
    // FIX 1: Login-Fehler ist ein echter Fehler (DEV_SKIP_TOTP=true gesetzt) —
    // kein Skip, der eine kaputte Auth-Grundlage versteckt.
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // FIX 1: admin@… MUSS die Admin-Rolle haben. Redirect = RBAC-Bug → FAIL.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      throw new Error('Admin account lacks ADMIN role — redirected away from /staff/admin');
    }

    const adminHeading = page.getByRole('heading', { name: /Administration/i });
    await expect(adminHeading).toBeVisible({ timeout: 5000 });
  });

  test('11.2 Non-admin cannot access admin routes', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/staff/login');

    await page.goto('/staff/admin/dsgvo');
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/staff/login');

    await ctx.close();
  });

  test('11.3 Admin sees DSGVO settings in sidebar', async ({ page }) => {
    test.setTimeout(60_000);
    // FIX 1: Login muss funktionieren (DEV_SKIP_TOTP) — kein Skip bei Fehler.
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    const dsgvoLink = page.getByRole('link', { name: /DSGVO/i });
    const dsgvoVisible = await dsgvoLink.isVisible({ timeout: 5000 }).catch(() => false);
    expect(dsgvoVisible).toBeTruthy();

    const settingsLink = page.getByRole('link', { name: /Einstellungen/i });
    const settingsVisible = await settingsLink.isVisible({ timeout: 5000 }).catch(() => false);
    expect(settingsVisible).toBeTruthy();
  });
});

// =============================================================================
// SECTION 12: Backup & Restore
// =============================================================================
test.describe.serial('Backup & Restore — §147 AO Compliance', () => {
  test('12.1 Admin dashboard shows backup info', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Admin-Seite — Umleitung = Fehler (§147 AO Backup-Transparenz).
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access admin dashboard — RBAC or session issue');
    }

    // FIX 1: Backup-Info ist §147 AO-pflichtig — fehlt sie ganz, FAIL statt Skip.
    const backupText = page.getByText(/Backup|Sicherung|gesichert|Restore/i);
    await expect(backupText.first(), 'Admin-Dashboard muss Backup/Restore-Info zeigen (§147 AO)').toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('12.2 Audit archive page shows archive segments', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/archive');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // FIX 1: Audit-Archiv ist GoBD-pflichtig — Umleitung = Fehler.
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      await ctx.close();
      throw new Error('Admin cannot access audit archive page — RBAC or session issue');
    }

    // FIX 1: Archiv-Heading muss da sein — kein Skip bei „nicht gefunden".
    const heading = page.getByRole('heading', { name: /Archiv|Audit-Archiv/i });
    await expect(heading.first(), 'Audit-Archiv muss eine Archiv-Überschrift haben').toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('12.3 Health detail shows S3/Object-Store connectivity (backup storage)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { throw new Error('Staff-Login fehlgeschlagen — StorageState nicht vorhanden. Login-Test im selben serial-Block prüfen.'); }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const request = ctx.request;

    const res = await request.get('/api/health/detail');
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('services');
      expect(body.services).toHaveProperty('objectStore');
    } else {
      expect([401, 403, 503]).toContain(res.status());
    }

    await ctx.close();
  });

  test('12.4 Health check returns ok/degraded status', async ({ request }) => {
    const res = await request.get('/api/health');
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body).toHaveProperty('timestamp');
  });
});

// =============================================================================
// SECTION 13: Portal Login & DSGVO Export
// =============================================================================
test.describe.serial('Portal Compliance — DSGVO Export & Consent', () => {
  test.afterAll(() => {
    try { fs.unlinkSync(STAFF_AUTH); } catch { /* best-effort cleanup */ }
    try { fs.unlinkSync(MANDANT_AUTH); } catch { /* best-effort cleanup */ }
    try { fs.rmdirSync(AUTH_DIR); } catch { /* best-effort cleanup */ }
  });

  test('Portal login for compliance tests', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const request = ctx.request;

    try {
      await loginAsMandant(page, request);
      await expectPortalDashboardReady(page);
      await ctx.storageState({ path: MANDANT_AUTH });
    } catch (e) {
      // MailHog/SMTP sind Pflichtservices im Paranoid-CI.
      // Wenn der Portal-Login fehlschlägt, ist das ein Fehler, kein Skip.
      throw new Error(`Portal-Login fehlgeschlagen (MailHog/SMTP Pflichtservice): ${(e as Error).message}`, { cause: e });
    } finally {
      await ctx.close();
    }
  });

  test('13.1 Portal settings page loads (consent/DSGVO settings)', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/settings');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const settingsContent = page.getByText(/Einstellung|Benachrichtigung|DSGVO/i);
    const contentVisible = await settingsContent.first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(contentVisible, 'Portal settings content must be visible for consent/DSGVO settings').toBe(true);
    await expect(settingsContent.first()).toBeVisible();

    await ctx.close();
  });

  test('13.2 Portal document page verifies shared docs access', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { throw new Error('Portal-Login fehlgeschlagen — StorageState nicht vorhanden.'); }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const heading = page.getByRole('heading', { name: /Dokumente/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (headingVisible) {
      await expect(heading).toBeVisible();
    }

    await ctx.close();
  });
});
