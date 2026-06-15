// =============================================================================
// 11-upload-fuzz.spec.ts
//
// Focused negative/fuzz cases for the real upload API. These are deliberately
// API-level tests: the browser UI can be perfect while a direct multipart
// request still bypasses validation, CSRF or parser limits.
// =============================================================================
import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

const BASE_ORIGIN = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

function createPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n', 'utf-8');
}

test.describe.serial('Upload API fuzz and negative cases', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('rejects missing classification/documentTypeId before storage commit', async ({ page }) => {
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: BASE_ORIGIN },
      multipart: {
        file: { name: 'missing-classification.pdf', mimeType: 'application/pdf', buffer: createPdf() },
        title: 'missing classification',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error ?? '').toMatch(/validation/i);
  });

  test('rejects overlong title with validation error, not 500', async ({ page }) => {
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: BASE_ORIGIN },
      multipart: {
        file: { name: 'long-title.pdf', mimeType: 'application/pdf', buffer: createPdf() },
        title: 'A'.repeat(501),
        classification: 'GENERAL',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error ?? '').toMatch(/validation/i);
  });

  test('rejects cross-origin multipart before accepting valid-looking bytes', async ({ page }) => {
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: 'https://attacker.example' },
      multipart: {
        file: { name: 'valid-looking.pdf', mimeType: 'application/pdf', buffer: createPdf() },
        title: 'cross-origin upload',
        classification: 'GENERAL',
      },
    });
    expect(res.status()).toBe(403);
  });

  test('sanitizes CRLF filename on download response headers', async ({ page }) => {
    const title = `E2E Header Injection ${Date.now()}\r\nX-Injected: yes`;
    const res = await page.request.post('/api/staff/documents/commit', {
      headers: { Origin: BASE_ORIGIN },
      multipart: {
        file: {
          name: 'valid-header-injection-carrier.pdf',
          mimeType: 'application/pdf',
          buffer: createPdf(),
        },
        title,
        classification: 'GENERAL',
      },
    });
    const body = await res.json().catch(() => ({}));
    expect(res.status(), `commit failed: ${JSON.stringify(body)}`).toBe(200);

    const download = await page.request.get(`/api/staff/documents/${body.documentId}/download`);
    expect(download.status()).toBe(200);
    const disposition = download.headers()['content-disposition'] ?? '';
    expect(disposition).toContain('attachment;');
    expect(disposition).not.toMatch(/\r|\n|X-Injected/i);
  });
});
