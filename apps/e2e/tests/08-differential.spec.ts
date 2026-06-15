// =============================================================================
// 08-differential.spec.ts
//
// Differential E2E: one controlled document upload is observed through
// independent surfaces. API response, Postgres rows, download bytes and UI must
// agree on the same immutable facts.
// =============================================================================
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { loginAsAdmin } from './helpers/auth';

const BASE_ORIGIN = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
const PG_CONTAINER = process.env['E2E_POSTGRES_CONTAINER'] ?? 'taxtronik-postgres';
const PG_USER = process.env['E2E_POSTGRES_USER'] ?? 'taxtronik';
const PG_DB = process.env['E2E_POSTGRES_DB'] ?? 'taxtronik';
const PG_HOST = process.env['E2E_POSTGRES_HOST'] ?? 'localhost';
const PG_PASSWORD = process.env['E2E_POSTGRES_PASSWORD'] ?? 'taxtronik';
const CURRENT_YEAR = new Date().getUTCFullYear();

const CASES = [
  {
    label: 'general',
    classification: 'GENERAL',
    expectedBucket: process.env['S3_BUCKET_GENERAL'] ?? 'general',
    expectedImmutable: false,
    expectedRetentionYear: '',
    expectedKeySegment: '/none/',
  },
  {
    label: 'gobd',
    classification: 'GOBD_INVOICE',
    expectedBucket: process.env['S3_BUCKET_GOBD'] ?? 'gobd',
    expectedImmutable: true,
    expectedRetentionYear: String(CURRENT_YEAR + 11),
    expectedKeySegment: '/gobd/',
  },
  {
    label: 'gwg',
    classification: 'GWG_EVIDENCE',
    expectedBucket: process.env['S3_BUCKET_GWG'] ?? 'gwg',
    expectedImmutable: true,
    expectedRetentionYear: String(CURRENT_YEAR + 6),
    expectedKeySegment: '/gwg/',
  },
] as const;

function createPdf(marker: string): Buffer {
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
    `% Differential marker: ${marker}`,
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
  ].join('\n'), 'utf-8');
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

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

test.describe.serial('Differential invariants', () => {
  test('document uploads match API, DB, audit, download bytes and UI across protection tiers', async ({ page }) => {
    test.setTimeout(180_000);

    await loginAsAdmin(page);
    await expect(page).toHaveURL(/\/staff\/dashboard/, { timeout: 15_000 });

    for (const c of CASES) {
      const marker = `e2e-differential-${c.label}-${Date.now()}`;
      const title = `E2E Differential ${c.label} ${marker}`;
      const bytes = createPdf(marker);
      const expectedSha = sha256Hex(bytes);

      const commit = await page.request.post('/api/staff/documents/commit', {
        headers: { Origin: BASE_ORIGIN },
        multipart: {
          file: {
            name: `${marker}.pdf`,
            mimeType: 'application/pdf',
            buffer: bytes,
          },
          title,
          classification: c.classification,
        },
      });

      const commitBody = await commit.json().catch(() => ({}));
      expect(commit.status(), `${c.label} commit failed: ${JSON.stringify(commitBody)}`).toBe(200);
      expect(commitBody.ok).toBe(true);
      expect(commitBody.documentId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(commitBody.sha256).toBe(expectedSha);
      expect(commitBody.immutable).toBe(c.expectedImmutable);

      const documentId = String(commitBody.documentId);
      const dbRow = psql(`
        SELECT
          d.title,
          d.classification,
          d.mime_type,
          encode(v.sha256, 'hex'),
          v.size_bytes::text,
          v.storage_bucket,
          v.storage_key,
          v.version_no::text,
          v.scan_status,
          v.immutable::text,
          (d.deleted_at IS NULL)::text,
          COALESCE(date_part('year', d.retention_until)::int::text, '')
        FROM document d
        JOIN document_version v ON v.document_id = d.id
        WHERE d.id = '${documentId}'
        ORDER BY v.version_no DESC
        LIMIT 1
      `);
      const [
        dbTitle,
        dbClassification,
        dbMime,
        dbSha,
        dbSize,
        dbBucket,
        dbKey,
        dbVersion,
        dbScanStatus,
        dbImmutable,
        dbActive,
        dbRetentionYear,
      ] = dbRow.split('|');

      expect(dbTitle).toBe(title);
      expect(dbClassification).toBe(c.classification);
      expect(dbMime).toBe('application/pdf');
      expect(dbSha).toBe(expectedSha);
      expect(Number(dbSize)).toBe(bytes.length);
      expect(dbBucket).toBe(c.expectedBucket);
      expect(dbKey).toContain(c.expectedKeySegment);
      expect(dbVersion).toBe('1');
      expect(dbScanStatus).toBe('CLEAN');
      expect(dbImmutable).toBe(String(c.expectedImmutable));
      expect(dbActive).toBe('true');
      expect(dbRetentionYear).toBe(c.expectedRetentionYear);

      const auditRows = Number(psql(`
        SELECT count(*)
        FROM audit_log
        WHERE resource_type = 'document'
          AND resource_id = '${documentId}'
          AND action = 'document.upload'
          AND after->>'sha256' = '${expectedSha}'
          AND after->>'classification' = '${c.classification}'
      `));
      expect(auditRows, `${c.label} upload audit log must contain exact classification and SHA-256`).toBeGreaterThanOrEqual(1);

      const preview = await page.request.get(`/api/staff/documents/${documentId}/preview-url`);
      expect(preview.status()).toBe(200);
      const previewBody = await preview.json();
      expect(previewBody.title).toBe(title);
      expect(previewBody.mimeType).toBe('application/pdf');
      expect(previewBody.url).toBe(`/api/staff/documents/${documentId}/preview-url?stream=1`);

      const download = await page.request.get(`/api/staff/documents/${documentId}/download`);
      expect(download.status()).toBe(200);
      expect(download.headers()['content-type']).toContain('application/pdf');
      const downloadedBytes = await download.body();
      expect(sha256Hex(downloadedBytes)).toBe(expectedSha);

      await page.goto(`/staff/documents/${documentId}`);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 8_000 });
      await expect(page.getByText(`SHA-256: ${expectedSha.slice(0, 12)}`).first()).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText(/v1/).first()).toBeVisible({ timeout: 5_000 });
      if (c.expectedImmutable) {
        await expect(page.getByText(/GoBD-immutable|Aufbewahrung bis/).first()).toBeVisible({ timeout: 5_000 });
      }
    }
  });
});
