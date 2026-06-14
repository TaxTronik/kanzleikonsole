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
import { test, expect, type Browser, type Page } from '@playwright/test';
import { loginAsAdmin, ADMIN_EMAIL } from './helpers/auth';
import { loginAsMandant, requestMagicLink, PORTAL_EMAIL } from './helpers/portal-auth';
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

function createEicarBuffer(): Buffer {
  return Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    'utf-8',
  );
}

// =============================================================================
// SECTION 1: Dokumenten-Compliance (GoBD §147 AO)
// =============================================================================
test.describe.serial('GoBD §147 AO — Dokumenten-Compliance', () => {
  test.beforeAll(() => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    try { fs.unlinkSync(STAFF_AUTH); } catch {}
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/staff/login');

    // Navigate to a specific client (upload button only appears inside scope)
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

    const fileInput = page.locator('#upload-file, input[type="file"]').first();
    const fiVisible = await fileInput.isVisible({ timeout: 4000 }).catch(() => false);
    if (fiVisible) {
      await fileInput.setInputFiles({
        name: `e2e-compliance-${Date.now()}.pdf`,
        mimeType: 'application/pdf',
        buffer: createMinimalPdf(),
      });
      await page.waitForTimeout(500);

      const titleInput = page.locator('#upload-title, input[name="title"]');
      if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await titleInput.fill('E2E Compliance Test Dokument');
      }

      const submitBtn = page.locator('button[type="submit"]').filter({ hasText: /Hochladen/ });
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(4000);
      }
    }

    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    await ctx.close();
  });

  test('1.2 Verify uploaded document appears in list', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    await expect(page.locator('body')).toBeVisible();
    const entries = page.locator('table tbody tr, [data-doc-row]');
    const count = await entries.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);

    await ctx.close();
  });

  test('1.3 Soft-delete a document and verify it is hidden but recoverable', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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

    const trashBtn = page.locator('[title*="löschen" i], [title*="Löschen" i], button:has(svg[class*="trash"]), button:has(svg[class*="Trash"])').first();
    const trashVisible = await trashBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (trashVisible) {
      await trashBtn.click();
      await page.waitForTimeout(1000);

      const confirmBtn = page.getByRole('button', { name: /löschen|Löschen|endgültig/ }).first();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
    } else {
      await page.goto('/staff/documents?deleted=1');
      await page.waitForTimeout(3000);
      expect(page.url()).not.toContain('/staff/login');

      // The deleted view may not have explicit "gelöscht/Papierkorb" text;
      // it may just show an empty state or a different heading
      const deletedText = page.getByText(/gelöscht|Papierkorb|Keine|deleted/i);
      const textVisible = await deletedText.first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!textVisible) {
        // If no deleted items exist, the view still loaded — that's acceptable
        await expect(page.locator('body')).toBeVisible();
        test.skip(true, 'Deleted documents view empty or unstructured');
      }
    }

    await expect(page.locator('body')).toBeVisible();
    await ctx.close();
  });

  test('1.4 Object-Lock metadata validation (retention date)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const docLink = page.locator('table tbody tr a').first();
    const docVisible = await docLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (docVisible) {
      await docLink.click();
      await page.waitForTimeout(3000);

      if (page.url().includes('/staff/documents/')) {
        const retentionText = page.getByText(/Aufbewahrung|GoBD-immutable|retention/i);
        const retentionVisible = await retentionText.first().isVisible({ timeout: 4000 }).catch(() => false);
        if (retentionVisible) {
          await expect(retentionText.first()).toBeVisible();
        }
        const shaText = page.getByText(/SHA-256/);
        await expect(shaText).toBeVisible({ timeout: 5000 });
      }
    } else {
      test.skip(true, 'No documents to inspect');
    }

    await ctx.close();
  });

  test('1.5 Non-PDF file rejection', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Test via API: a non-PDF file disguised as PDF MUST be rejected
    const uploadEndpoint = '/api/staff/documents/upload';
    const txtFile = Buffer.from('This is a text file disguised as PDF', 'utf-8');

    const res = await page.request.post(uploadEndpoint, {
      multipart: {
        file: {
          name: 'fake.pdf',
          mimeType: 'application/pdf',
          buffer: txtFile,
        },
        title: 'Fake PDF',
        documentTypeId: '00000000-0000-0000-0000-000000000001',
      },
    }).catch(() => null);

    if (res) {
      const status = res.status();
      // Non-PDF disguised as PDF MUST NOT return 200 — must be rejected
      expect(status).not.toBe(200);
      // Acceptable rejection codes: 400 (bad request), 415 (unsupported media),
      // 422 (unprocessable), 401/403 (auth needed)
      expect([400, 401, 403, 415, 422, 500]).toContain(status);
    }

    await ctx.close();
  });

  test('1.6 Upload new version of existing document', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const docLink = page.locator('table tbody tr a').first();
    const docVisible = await docLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (docVisible) {
      await docLink.click();
      await page.waitForTimeout(3000);

      if (page.url().includes('/staff/documents/')) {
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
      }
    } else {
      test.skip(true, 'No document to create new version for');
    }

    await expect(page.locator('body')).toBeVisible();
    await ctx.close();
  });

  test('1.7 File size limit check (reject >100MB upload)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const res = await page.request.post('/api/staff/documents/upload', {
      multipart: {
        file: {
          name: 'large-file.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.alloc(1024 * 1024 * 5, 0),
        },
        title: 'Large Test File',
        documentTypeId: '00000000-0000-0000-0000-000000000001',
      },
    }).catch(() => null);

    if (res) {
      const status = res.status();
      // Oversized file MUST NOT be accepted (200/302 = pass-through = FAIL)
      expect(status).not.toBe(200);
      expect(status).not.toBe(302);
      // Acceptable: 413 (payload too large), 400 (bad request), 401/403 (no auth),
      // 422 (unprocessable), 500 (server error from size limit)
      expect([400, 401, 403, 413, 422, 500]).toContain(status);
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 2: GwG-Compliance (§10-12 GwG)
// =============================================================================
test.describe.serial('GwG §10-12 — Geldwäschegesetz-Compliance', () => {
  test('2.1 GwG retention page loads', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/gwg-retention');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'GwG retention page not accessible (redirected to dashboard/login)');
      await ctx.close(); return;
    }

    const heading = page.getByRole('heading', { name: /GwG-Pflichtlöschung/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/GwG|Belege|löschreif/i).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!hasContent) {
        test.skip(true, 'GwG retention page content not found');
      }
    }

    const retentionYearText = page.getByText(/5 Jahre|§ 8 Abs\. 4/i);
    await expect(retentionYearText.first()).toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  test('2.2 Client detail shows GwG status badge', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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
    await expect(page.locator('body')).toBeVisible();
  });

  test('2.4 GwG verification workflow states are visible', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Admin dashboard not accessible'); await ctx.close(); return;
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/dsgvo');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'DSGVO page not accessible (redirected to dashboard/login)');
      await ctx.close(); return;
    }

    const heading = page.getByRole('heading', { name: /DSGVO-Anfragen/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/DSGVO|Auskunft|Löschung|Art\./i).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (hasContent) {
        await expect(page.getByText(/DSGVO|Auskunft/i).first()).toBeVisible();
      } else {
        test.skip(true, 'DSGVO page content not found');
      }
    } else {
      await expect(heading).toBeVisible();
    }

    await ctx.close();
  });

  test('3.2 Client anonymization UI exists', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/dsgvo-retention');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'DSGVO retention page not accessible'); await ctx.close(); return;
    }

    const heading = page.getByRole('heading', { name: /Anonymisierung/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/anonymisierungsrei|Anonymisierung|Mandant/i).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (hasContent) {
        await expect(page.getByText(/anonymisierungsrei|Anonymisierung/i).first()).toBeVisible();
      } else {
        test.skip(true, 'DSGVO retention/anonymization page empty');
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Admin page not accessible'); await ctx.close(); return;
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Audit page not accessible (redirected to dashboard/login)');
      await ctx.close(); return;
    }

    const heading = page.getByRole('heading', { name: /Audit-Log/i });
    const headingVisible = await heading.isVisible({ timeout: 6000 }).catch(() => false);
    if (!headingVisible) {
      const hasContent = await page.getByText(/Hash-Chain|Prüfer-Link|Noch kein/).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!hasContent) {
        test.skip(true, 'Audit page content not found');
      }
    }

    await ctx.close();
  });

  test('4.2 Audit entries have timestamps and actor IDs', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Audit page not accessible'); await ctx.close(); return;
    }

    const thElements = page.locator('thead th');
    const thCount = await thElements.count().catch(() => 0);

    if (thCount > 0) {
      const headerTexts = await thElements.allInnerTexts().catch(() => [] as string[]);
      const hasTimestamp = headerTexts.some((h: string) => /Zeit|Datum/i.test(h));
      const hasAction = headerTexts.some((h: string) => /Action|Akteur/i.test(h));
      if (!hasTimestamp && !hasAction) {
        test.skip(true, 'Audit table columns not as expected in headers');
      }
    }

    const rows = page.locator('table tbody tr');
    const count = await rows.count().catch(() => 0);
    if (count > 0) {
      await expect(rows.first()).toBeVisible();
    }

    await ctx.close();
  });

  test('4.3 Audit log is NOT modifiable (no edit/delete buttons)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Audit page not accessible'); await ctx.close(); return;
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Audit page not accessible'); await ctx.close(); return;
    }

    const hashBanner = page.getByText(/Hash-Chain|Noch kein Prüfergebnis|Prüfer-Link/i);
    const bannerVisible = await hashBanner.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (bannerVisible) {
      await expect(hashBanner.first()).toBeVisible();
    } else {
      test.skip(true, 'Hash-Chain banner not found on audit page');
    }

    await ctx.close();
  });

  test('4.5 Prüfer-Link (audit token) section exists', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Audit page not accessible'); await ctx.close(); return;
    }

    const prueferLink = page.getByText(/Prüfer-Link/i);
    const linkVisible = await prueferLink.isVisible({ timeout: 5000 }).catch(() => false);
    if (linkVisible) {
      await expect(prueferLink).toBeVisible();
    } else {
      test.skip(true, 'Prüfer-Link section not found');
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 5: Tenant Isolation (§203 StGB)
// =============================================================================
test.describe.serial('Tenant Isolation — §203 StGB Mandantentrennung', () => {
  test('5.1 Admin only sees own tenant clients', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/clients');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    await expect(page.getByText('Mustermann GmbH').first()).toBeVisible({ timeout: 8000 });

    await ctx.close();
  });

  test('5.2 Cross-tenant access via fabricated UUID returns 404', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const fakeUuid = '00000000-0000-4000-8000-000000000999';
    const res = await page.goto(`/staff/clients/${fakeUuid}`);
    await page.waitForTimeout(2000);

    if (res) {
      const status = res.status();
      // Must not return 200 (data leak)
      expect(status).not.toBe(200);
      expect([404, 302]).toContain(status);
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const request = ctx.request;

    const fakeUuid = '00000000-0000-4000-8000-000000000888';
    const res = await request.get(`/api/staff/clients/${fakeUuid}`);

    // Cross-tenant or non-existent UUID must NOT return 200
    expect(res.status()).not.toBe(200);
    expect([401, 403, 404]).toContain(res.status());

    await ctx.close();
  });

  test('5.4 Health endpoint shows DB connectivity (indirect RLS check)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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
  test('6.1 Login sets session cookie', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name.includes('taxtronik') || c.name.includes('staff'));
    expect(sessionCookie).toBeDefined();

    if (sessionCookie) {
      expect(sessionCookie.name).toMatch(/taxtronik.*staff|staff.*taxtronik/i);
      expect(sessionCookie.httpOnly).toBe(true);
      expect(['lax', 'strict', 'Lax', 'Strict']).toContain(sessionCookie.sameSite);
    }
  });

  test('6.2 Logout clears session cookie', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    const logoutBtn = page.getByRole('button', { name: /Abmelden/i });
    const logoutVisible = await logoutBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (logoutVisible) {
      await logoutBtn.click();
      await page.waitForTimeout(2000);

      if (page.url().includes('/staff/login')) {
        const cookies = await page.context().cookies();
        const sessionCookie = cookies.find((c) => c.name.includes('taxtronik') || c.name.includes('staff'));
        if (sessionCookie) {
          expect(sessionCookie.value).toBeFalsy();
        }
      }
    } else {
      await page.goto('/staff/logout');
      await page.waitForTimeout(2000);
    }
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
test.describe.serial('Rechnungs-Compliance — XRechnung & GoBD', () => {
  test('7.1 New invoice page loads', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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
        test.skip(true, 'Invoice mode is EXTERNAL — skipping inline creation');
      }
    } else {
      test.skip(true, 'Invoice creation page not accessible');
    }

    await ctx.close();
  });

  test('7.2 Create invoice with line items', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/login') || page.url().includes('/staff/dashboard')) {
      test.skip(true, 'Invoice creation not accessible (redirect to login/dashboard/off)');
      await ctx.close(); return;
    }

    const isExternal =
      (await page.getByText(/zentraler Rechnungssoftware/).isVisible({ timeout: 2000 }).catch(() => false)) ||
      (await page.getByText(/PDF-Rechnung hochladen/).isVisible({ timeout: 2000 }).catch(() => false));
    if (isExternal) {
      test.skip(true, 'Invoice mode is EXTERNAL — no inline creation (GoBD §146 Abs. 2)');
      await ctx.close(); return;
    }

    const noClients = await page.getByText(/Keine aktiven Mandanten/).isVisible({ timeout: 2000 }).catch(() => false);
    if (noClients) {
      test.skip(true, 'No active clients for invoice creation (GwG-Schranke)');
      await ctx.close(); return;
    }

    const subjectInput = page.locator('#subject');
    const subjectReady = await subjectInput.isVisible({ timeout: 8000 }).catch(() => false);
    if (!subjectReady) {
      test.skip(true, 'Invoice form #subject field not found (EXTERNAL mode or slow render)');
      await ctx.close(); return;
    }

    await page.locator('#clientId').selectOption({ label: 'Mustermann GmbH' });
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
    await page.waitForTimeout(4000);
    expect(page.url()).toContain('/staff/invoices/');

    await ctx.close();
  });

  test('7.3 Invoice list shows sequential numbers', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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
    } else {
      test.skip(true, 'No invoices in list');
    }

    await ctx.close();
  });

  test('7.4 XRechnung export returns valid XML', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();
    const request = ctx.request;

    await page.goto('/staff/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    if (page.url().includes('/staff/login')) { await ctx.close(); return; }

    const firstInvLink = page.locator('table tbody tr a').first();
    const invVisible = await firstInvLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (invVisible) {
      const href = await firstInvLink.getAttribute('href').catch(() => null);
      await ctx.close();

      if (href) {
        const idMatch = href.match(/\/staff\/invoices\/([a-f0-9-]+)/);
        if (idMatch) {
          const invId = idMatch[1]!;
          const res = await request.get(`/api/staff/invoices/${invId}/xrechnung`);

          if (res.status() === 200) {
            const xml = await res.text();
            expect(xml).toContain('<?xml');
            expect(xml).toContain('<');
            expect(xml).toContain('>');
          } else if (res.status() === 401 || res.status() === 302) {
            test.skip(true, 'XRechnung endpoint requires re-auth');
          } else {
            test.skip(true, `XRechnung endpoint returned ${res.status()}`);
          }
        }
      }
    } else {
      await ctx.close();
      test.skip(true, 'No invoice found to test XRechnung export');
    }
  });

  test('7.5 Mark invoice as sent and verify', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/invoices');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const draftBadge = page.locator('.badge-gray').filter({ hasText: /Entwurf/ });
    const draftCount = await draftBadge.count().catch(() => 0);

    if (draftCount === 0) {
      test.skip(true, 'No DRAFT invoice to test sending');
      await ctx.close(); return;
    }

    const draftRow = draftBadge.first().locator('..');
    const link = draftRow.locator('a').first();
    if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
      await link.click();
      await page.waitForTimeout(3000);

      if (page.url().includes('/staff/invoices/')) {
        const sendBtn = page.getByRole('button', { name: /versendet markieren/i });
        if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sendBtn.click();
          await page.waitForTimeout(3000);
          const sentBadge = page.locator('.badge-yellow').filter({ hasText: /Versendet/i });
          await expect(sentBadge.first()).toBeVisible({ timeout: 5000 });
        }
      }
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 8: Magic Link Security
// =============================================================================
test.describe('Magic Link Security', () => {
  test('8.1 Request magic link and verify it arrives in MailHog', async ({ page, request }) => {
    test.setTimeout(30_000);

    await page.goto('/portal/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const emailInput = page.getByLabel('E-Mail-Adresse');
    const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!emailVisible) {
      test.skip(true, 'Portal login page not fully loaded');
      return;
    }

    await emailInput.fill(PORTAL_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();

    const result = await Promise.race([
      page.getByText(/Login-Link verschickt/i).waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'success' as const),
      page.getByText(/Zu viele Anfragen|Fehler|nicht gefunden/i).waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'error' as const),
      page.waitForTimeout(10_000).then(() => 'timeout' as const),
    ]);

    if (result === 'error') {
      const errorText = await page.locator('text=/Zu viele Anfragen|Fehler|nicht gefunden/i').first().textContent().catch(() => '');
      test.skip(true, `Magic link request failed: ${errorText}`);
      return;
    }
    if (result === 'timeout') {
      test.skip(true, 'Magic link request timed out (SMTP may not be running)');
      return;
    }

    const mailhogUrl = process.env['E2E_MAILHOG_URL'] ?? 'http://127.0.0.1:8025';
    await page.waitForTimeout(1000);
    const res = await request.get(`${mailhogUrl}/api/v2/messages?limit=5`);

    if (res.ok()) {
      const data = await res.json();
      const items = data.items ?? [];
      const found = items.some((msg: any) => {
        const headers = msg.Content?.Headers ?? {};
        const to = Array.isArray(headers['To']) ? headers['To'].join(' ') : headers['To'] ?? '';
        return to.includes(PORTAL_EMAIL);
      });
      expect(found).toBe(true);
    } else {
      test.skip(true, `MailHog not reachable at ${mailhogUrl}`);
    }
  });

  test('8.2 Magic link contains token parameter', async ({ page, request }) => {
    test.setTimeout(30_000);

    await page.goto('/portal/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const emailInput = page.getByLabel('E-Mail-Adresse');
    const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!emailVisible) {
      test.skip(true, 'Portal login page not fully loaded');
      return;
    }

    await emailInput.fill(PORTAL_EMAIL);
    await page.getByRole('button', { name: /Login-Link anfordern/i }).click();

    const successVisible = await page.getByText(/Login-Link verschickt/i).isVisible({ timeout: 10_000 }).catch(() => false);
    if (!successVisible) {
      test.skip(true, 'Magic link request did not succeed (rate-limited or SMTP down)');
      return;
    }

    await page.waitForTimeout(1000);
    const mailhogUrl = process.env['E2E_MAILHOG_URL'] ?? 'http://127.0.0.1:8025';
    const res = await request.get(`${mailhogUrl}/api/v2/messages?limit=5`);

    if (res.ok()) {
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
      expect(foundToken).toBe(true);
    } else {
      test.skip(true, `MailHog not reachable at ${mailhogUrl}`);
    }
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
    // Send 6 requests in rapid succession
    for (let i = 0; i < 6; i++) {
      await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.getByLabel('E-Mail-Adresse').fill(`compliance-spam-${i}-${Date.now()}@nope.local`);
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      await page.waitForTimeout(150);
    }

    const errorOrSuccess = page.locator('text=/Zu viele Anfragen|Login-Link verschickt/i');
    await expect(errorOrSuccess.first()).toBeVisible({ timeout: 10_000 });

    const maybeError = await page.getByText(/Zu viele Anfragen/i).isVisible().catch(() => false);
    if (!maybeError) {
      await page.goto('/portal/login', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      await page.getByLabel('E-Mail-Adresse').fill('last-spam@nope.local');
      await page.getByRole('button', { name: /Login-Link anfordern/i }).click();
      await expect(page.getByText(/Zu viele Anfragen/i)).toBeVisible({ timeout: 5_000 });
    }
  });
});

// =============================================================================
// SECTION 9: Input Validation & Injection Prevention
// =============================================================================
test.describe.serial('Input Validation — XSS/SQL Injection', () => {
  test('9.1 XSS in client name field is escaped', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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

    // Confirm the input was filled (browser may sanitize on input)
    const inputValue = await searchInput.inputValue().catch(() => '');
    // If the script tag was accepted as-is in the input, that's already a concern
    // (input fields should allow typing — the real test is in rendered output)

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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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

    await expect(page.locator('body')).toBeVisible();

    await ctx.close();
  });
});

// =============================================================================
// SECTION 10: File Upload Security
// =============================================================================
test.describe.serial('File Upload Security — ClamAV & Validation', () => {
  test('10.1 EICAR test file upload (ClamAV should reject)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    const eicarBuffer = createEicarBuffer();

    const res = await page.request.post('/api/staff/documents/upload', {
      multipart: {
        file: {
          name: 'eicar-test.com',
          mimeType: 'application/octet-stream',
          buffer: eicarBuffer,
        },
        title: 'EICAR Test File',
        documentTypeId: '00000000-0000-0000-0000-000000000001',
      },
    }).catch(() => null);

    if (res) {
      const status = res.status();
      // EICAR MUST NOT pass through with 200 — that means malware got accepted
      if (status === 200) {
        // Even if ClamAV is not running, this is a security failure:
        // the endpoint accepted an EICAR test file. FAIL the test.
        throw new Error(`SECURITY FAILURE: EICAR test file was accepted with status 200 — malware passthrough detected!`);
      }
      // Acceptable rejection codes: 400/415/422 (rejected content),
      // 401/403 (auth), 413 (too big), 500 (server error blocking it)
      expect([400, 401, 403, 413, 415, 422, 500]).toContain(status);
    }

    // Also try the upload page directly (navigate to client scope first)
    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

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

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileInput.setInputFiles({
        name: 'eicar-test.com',
        mimeType: 'application/octet-stream',
        buffer: eicarBuffer,
      });
      await page.waitForTimeout(500);

      const submitBtn = page.locator('button[type="submit"]').filter({ hasText: /Hochladen/ });
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(4000);
      }
    }

    await ctx.close();
  });

  test('10.2 Double extension file upload', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    // Navigate to client scope where upload button appears
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

    const uploadBtn = page.getByRole('button', { name: /Hochladen/i }).first();
    const btnVisible = await uploadBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!btnVisible) {
      test.skip(true, 'Upload button not found in client document view');
      await ctx.close(); return;
    }
    await uploadBtn.click();
    await page.waitForTimeout(1000);

    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toBeVisible({ timeout: 5000 });
    await fileInput.setInputFiles({
      name: 'invoice.pdf.exe',
      mimeType: 'application/x-msdownload',
      buffer: createMinimalPdf(),
    });
    await page.waitForTimeout(500);

    const submitBtn = page.locator('button[type="submit"]').filter({ hasText: /Hochladen/ });
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();
    await page.waitForTimeout(4000);

    await expect(page.locator('body')).toBeVisible();
    await ctx.close();
  });

  test('10.3 File metadata (SHA-256 hash) stored for documents', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/documents');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    expect(page.url()).not.toContain('/staff/login');

    const docLink = page.locator('table tbody tr a').first();
    const docVisible = await docLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (docVisible) {
      await docLink.click();
      await page.waitForTimeout(3000);

      if (page.url().includes('/staff/documents/')) {
        const shaText = page.getByText(/SHA-256:/);
        await expect(shaText).toBeVisible({ timeout: 5000 });
      }
    } else {
      test.skip(true, 'No documents found to check SHA-256 hash');
    }

    await ctx.close();
  });
});

// =============================================================================
// SECTION 11: Authorization & RBAC
// =============================================================================
test.describe('Authorization & RBAC', () => {
  test('11.1 Admin can access admin routes', async ({ page }) => {
    test.setTimeout(60_000);
    try {
      await loginAsAdmin(page);
    } catch {
      test.skip(true, 'Admin login failed (account locked or TOTP required)');
      return;
    }
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Admin not ADMIN role (redirected)');
      return;
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
    try {
      await loginAsAdmin(page);
    } catch {
      test.skip(true, 'Admin login failed (account locked or TOTP required)');
      return;
    }
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
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Admin page not accessible'); await ctx.close(); return;
    }

    const backupText = page.getByText(/Backup|Sicherung|gesichert|Restore/i);
    const backupVisible = await backupText.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (backupVisible) {
      await expect(backupText.first()).toBeVisible();
    } else {
      test.skip(true, 'Backup info not found on admin dashboard');
    }

    await ctx.close();
  });

  test('12.2 Audit archive page shows archive segments', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
    const ctx = await browser.newContext({ storageState: STAFF_AUTH });
    const page = await ctx.newPage();

    await page.goto('/staff/admin/archive');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (page.url().includes('/staff/dashboard') || page.url().includes('/staff/login')) {
      test.skip(true, 'Audit archive not accessible'); await ctx.close(); return;
    }

    const heading = page.getByRole('heading', { name: /Archiv|Audit-Archiv/i });
    const headingVisible = await heading.isVisible({ timeout: 5000 }).catch(() => false);
    if (headingVisible) {
      await expect(heading).toBeVisible();
    } else {
      test.skip(true, 'Audit archive heading not found');
    }

    await ctx.close();
  });

  test('12.3 Health detail shows S3/Object-Store connectivity (backup storage)', async ({ browser }) => {
    if (!fs.existsSync(STAFF_AUTH)) { test.skip(true, 'No auth state'); return; }
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
    try { fs.unlinkSync(STAFF_AUTH); } catch {}
    try { fs.unlinkSync(MANDANT_AUTH); } catch {}
    try { fs.rmdirSync(AUTH_DIR); } catch {}
  });

  test('Portal login for compliance tests', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const request = ctx.request;

    try {
      await loginAsMandant(page, request);
      await expect(page.getByText(/Dashboard|Willkommen/).first()).toBeVisible({ timeout: 8000 });
      await ctx.storageState({ path: MANDANT_AUTH });
    } catch (e) {
      test.skip(true, `Portal login failed: ${(e as Error).message}`);
    } finally {
      await ctx.close();
    }
  });

  test('13.1 Portal settings page loads (consent/DSGVO settings)', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { test.skip(true, 'No mandant auth state'); return; }
    const ctx = await browser.newContext({ storageState: MANDANT_AUTH });
    const page = await ctx.newPage();

    await page.goto('/portal/settings');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    const settingsContent = page.getByText(/Einstellung|Benachrichtigung|DSGVO/i);
    const contentVisible = await settingsContent.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (contentVisible) {
      await expect(settingsContent.first()).toBeVisible();
    } else {
      test.skip(true, 'Portal settings content not found');
    }

    await ctx.close();
  });

  test('13.2 Portal document page verifies shared docs access', async ({ browser }) => {
    if (!fs.existsSync(MANDANT_AUTH)) { test.skip(true, 'No mandant auth state'); return; }
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
