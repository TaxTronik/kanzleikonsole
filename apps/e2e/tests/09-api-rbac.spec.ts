// =============================================================================
// 09-api-rbac.spec.ts
//
// Direct API authorization matrix. UI navigation tests are not enough for
// compliance software: protected API routes must fail closed without the right
// session type, and mutating staff APIs must reject cross-origin POSTs.
// =============================================================================
import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';
import { loginAsMandant } from './helpers/portal-auth';

const STAFF_DOC_UUID = '00000000-0000-0000-0000-000000000001';

function expectNotOk(status: number): void {
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).not.toBe(500);
}

test.describe.serial('API RBAC matrix', () => {
  test('protected APIs reject anonymous requests', async ({ request }) => {
    const staffSearch = await request.get('/api/staff/search?q=Mustermann');
    expect(staffSearch.status()).toBe(401);

    const staffNotifications = await request.get('/api/staff/notifications/count');
    expect(staffNotifications.status()).toBe(401);

    const staffDocument = await request.get(`/api/staff/documents/${STAFF_DOC_UUID}/download`);
    expect(staffDocument.status()).toBe(401);

    const portalPreview = await request.get(`/api/portal/documents/${STAFF_DOC_UUID}/preview-url`);
    expect(portalPreview.status()).toBe(401);
  });

  test('portal session cannot call staff APIs', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAsMandant(page, ctx.request);

    const staffSearch = await ctx.request.get('/api/staff/search?q=Mustermann');
    expect(staffSearch.status()).toBe(401);

    const staffDocument = await ctx.request.get(
      `/api/staff/documents/${STAFF_DOC_UUID}/preview-url`,
    );
    expect(staffDocument.status()).toBe(401);

    await ctx.close();
  });

  test('staff session cannot call portal APIs', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAsAdmin(page);

    const portalDocs = await ctx.request.get('/api/portal/documents');
    expectNotOk(portalDocs.status());
    expect([401, 404, 405]).toContain(portalDocs.status());

    const portalPreview = await ctx.request.get(
      `/api/portal/documents/${STAFF_DOC_UUID}/preview-url`,
    );
    expect(portalPreview.status()).toBe(401);

    await ctx.close();
  });

  test('staff document commit rejects cross-origin POST before upload semantics', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await loginAsAdmin(page);

    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: 'https://evil.example' },
      multipart: {
        file: {
          name: 'csrf.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF\n', 'utf-8'),
        },
        title: 'CSRF must fail',
        classification: 'GENERAL',
      },
    });

    expect(res.status()).toBe(403);
  });
});
