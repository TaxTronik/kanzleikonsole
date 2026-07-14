// =============================================================================
// 10-concurrency.spec.ts
//
// Race/TOCTOU E2E for compliance-critical document writes. Parallel requests
// must either commit consistently or fail with an explicit conflict, never with
// silent corruption, duplicate version numbers or 500s.
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

function createPdf(marker: string): Buffer {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj',
      `% Concurrency marker: ${marker}`,
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
    ].join('\n'),
    'utf-8',
  );
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
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

async function uploadDocument(
  request: import('@playwright/test').APIRequestContext,
  title: string,
  bytes: Buffer,
) {
  return request.post('/api/staff/documents/commit', {
    headers: { Origin: BASE_ORIGIN },
    multipart: {
      file: { name: `${title}.pdf`, mimeType: 'application/pdf', buffer: bytes },
      title,
      classification: 'GOBD_INVOICE',
    },
  });
}

test.describe.serial('Document write concurrency', () => {
  test('parallel document commits create unique documents, versions and audit rows', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loginAsAdmin(page);

    const runId = `e2e-concurrent-${Date.now()}`;
    const inputs = Array.from({ length: 6 }, (_, i) => {
      const title = `${runId}-${i}`;
      const bytes = createPdf(title);
      return { title, bytes, sha: sha256Hex(bytes) };
    });

    const responses = await Promise.all(
      inputs.map((i) => uploadDocument(page.request, i.title, i.bytes)),
    );
    const bodies = await Promise.all(responses.map((r) => r.json().catch(() => ({}))));

    for (let i = 0; i < responses.length; i++) {
      expect(
        responses[i]!.status(),
        `parallel commit ${i} failed: ${JSON.stringify(bodies[i])}`,
      ).toBe(200);
      expect(bodies[i].sha256).toBe(inputs[i]!.sha);
      expect(bodies[i].immutable).toBe(true);
    }

    const ids = bodies.map((b) => String(b.documentId));
    expect(new Set(ids).size).toBe(inputs.length);

    const quotedIds = ids.map((id) => `'${id}'`).join(',');
    const db = psql(`
      SELECT
        count(DISTINCT d.id)::text,
        count(DISTINCT v.id)::text,
        count(DISTINCT v.storage_key)::text,
        count(DISTINCT encode(v.sha256, 'hex'))::text,
        count(a.id)::text
      FROM document d
      JOIN document_version v ON v.document_id = d.id
      LEFT JOIN audit_log a
        ON a.resource_type = 'document'
       AND a.resource_id = d.id::text
       AND a.action = 'document.upload'
      WHERE d.id IN (${quotedIds})
    `);
    const [docCount, versionCount, keyCount, shaCount, auditCount] = db.split('|').map(Number);
    expect(docCount).toBe(inputs.length);
    expect(versionCount).toBe(inputs.length);
    expect(keyCount).toBe(inputs.length);
    expect(shaCount).toBe(inputs.length);
    expect(auditCount).toBe(inputs.length);
  });

  test('parallel new-version commits never produce duplicate version numbers or 500s', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loginAsAdmin(page);

    const title = `e2e-version-race-${Date.now()}`;
    const base = await uploadDocument(page.request, title, createPdf(`${title}-base`));
    const baseBody = await base.json().catch(() => ({}));
    expect(base.status(), `base commit failed: ${JSON.stringify(baseBody)}`).toBe(200);
    const documentId = String(baseBody.documentId);

    const attempts = Array.from({ length: 4 }, (_, i) => {
      const marker = `${title}-v${i}`;
      return page.request.post(`/api/staff/documents/${documentId}/new-version/commit`, {
        headers: { Origin: BASE_ORIGIN },
        multipart: {
          file: { name: `${marker}.pdf`, mimeType: 'application/pdf', buffer: createPdf(marker) },
          changeNote: `parallel attempt ${i}`,
        },
      });
    });

    const responses = await Promise.all(attempts);
    const statuses = responses.map((r) => r.status());
    expect(
      statuses,
      'parallel version commits must be explicit success/conflict, never crash',
    ).not.toContain(500);
    for (const status of statuses) expect([200, 409]).toContain(status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);

    const rows = psql(`
      SELECT version_no::text
      FROM document_version
      WHERE document_id = '${documentId}'
      ORDER BY version_no ASC
    `)
      .split('\n')
      .filter(Boolean)
      .map(Number);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows[0]).toBe(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toBe(rows[i - 1]! + 1);
    }
  });
});
