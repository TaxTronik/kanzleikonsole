// Fachkatalog: AUDIT-ARCHIVE-001
// Fachkatalog: AUDIT-RFC3161-ANCHOR-001
//
// F-12: Archivsegmente ohne RFC-3161-Token tragen tsa_status = PENDING und
// werden später nachgestempelt. Die Zeile bleibt ein Beleg: der UPDATE-Guard
// erlaubt nur den einmaligen Übergang PENDING -> STAMPED_LATE mit Token und
// Zeitpunkt; jede andere Änderung, DELETE und eine zweite Änderung scheitern.
// Die Bestandseinordnung der Migration wird in einer zurückgerollten
// Transaktion gegen den vorherigen Schemastand nachgespielt.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261005110100_audit_archive_tsa_status/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

function withoutTransaction(sql: string): string {
  return sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
}

describe('audit_archive tsa_status: Migration', () => {
  it('ersetzt nur den UPDATE-Trigger und behält search_path sowie DELETE/TRUNCATE-Sperren', () => {
    const sql = migration.replace(/--.*$/gm, '');
    expect(sql).toContain('DROP TRIGGER "audit_archive_no_update" ON "audit_archive";');
    expect(sql).not.toMatch(/DROP TRIGGER "audit_archive_no_(delete|truncate)"/);
    expect(sql.match(/SET search_path TO 'pg_catalog', 'public'/g)).toHaveLength(2);
    expect(sql).toMatch(/CHECK \("tsa_status" IN \('STAMPED', 'PENDING', 'STAMPED_LATE'\)\)/);
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Audit-Archiv-Statustest braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const tenantId = randomUUID();
const db = new PgClient({ connectionString: process.env['DATABASE_URL'] });

const INSERT = `
  INSERT INTO public.audit_archive
    (tenant_id, from_audit_id, to_audit_id, from_occurred_at, to_occurred_at, entry_count,
     first_prev_hash, last_this_hash, file_sha256, file_size_bytes, storage_bucket,
     storage_key, tsa_response_blob, tsa_status)
  VALUES ($1::uuid, $2::bigint, $2::bigint + 9, now(), now(), 10, '\\x00', '\\x01', '\\x02', 100,
          'gobd', 'tenants/' || $1::text || '/audit-archive/' || $2::text || '.ndjson', $3::bytea,
          $4::text)
  RETURNING id`;

async function expectRejected(sql: string, parameters: unknown[], message: RegExp) {
  await db.query('SAVEPOINT expected_rejection');
  try {
    await expect(db.query(sql, parameters)).rejects.toThrow(message);
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT expected_rejection');
    await db.query('RELEASE SAVEPOINT expected_rejection');
  }
}

describeWithDatabase('audit_archive tsa_status: Datenbank', () => {
  beforeAll(async () => {
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  it('erlaubt nur den einmaligen Nachstempel eines PENDING-Segments', async () => {
    await db.query('BEGIN');
    try {
      const pending = (await db.query(INSERT, [tenantId, 1, null, 'PENDING'])).rows[0].id;
      const stamped = (await db.query(INSERT, [tenantId, 11, Buffer.from('token'), 'STAMPED']))
        .rows[0].id;

      // Status und Token müssen zueinander passen.
      await expectRejected(INSERT, [tenantId, 21, Buffer.from('t'), 'PENDING'], /tsa_status_blob/);
      await expectRejected(INSERT, [tenantId, 31, null, 'STAMPED'], /tsa_status_blob/);
      await expectRejected(INSERT, [tenantId, 41, Buffer.from('t'), 'UNKNOWN'], /tsa_status_check/);

      // Beweisspalten und bereits gestempelte Segmente bleiben unveränderlich.
      await expectRejected(
        `UPDATE public.audit_archive SET storage_key = 'x' WHERE id = $1`,
        [pending],
        /insert-only/,
      );
      await expectRejected(
        `UPDATE public.audit_archive
            SET tsa_response_blob = '\\x09', tsa_status = 'STAMPED_LATE', tsa_stamped_at = now(),
                file_sha256 = '\\x0f'
          WHERE id = $1`,
        [pending],
        /insert-only/,
      );
      await expectRejected(
        `UPDATE public.audit_archive SET tsa_response_blob = '\\x09' WHERE id = $1`,
        [stamped],
        /insert-only/,
      );
      await expectRejected(
        `UPDATE public.audit_archive
            SET tsa_response_blob = '\\x09', tsa_status = 'STAMPED_LATE'
          WHERE id = $1`,
        [pending],
        /insert-only/,
      );
      await expectRejected(
        'DELETE FROM public.audit_archive WHERE id = $1',
        [pending],
        /insert-only/,
      );

      await db.query(
        `UPDATE public.audit_archive
            SET tsa_response_blob = '\\x09', tsa_serial = '0a', tsa_status = 'STAMPED_LATE',
                tsa_stamped_at = now()
          WHERE id = $1`,
        [pending],
      );
      const row = (
        await db.query(
          'SELECT tsa_status, tsa_serial, tsa_stamped_at FROM public.audit_archive WHERE id = $1',
          [pending],
        )
      ).rows[0];
      expect(row).toMatchObject({ tsa_status: 'STAMPED_LATE', tsa_serial: '0a' });
      expect(row.tsa_stamped_at).toBeInstanceOf(Date);

      // Ein zweiter Nachstempel ist ausgeschlossen.
      await expectRejected(
        `UPDATE public.audit_archive SET tsa_serial = '0b' WHERE id = $1`,
        [pending],
        /insert-only/,
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('ordnet Bestandssegmente beim Migrieren nach vorhandenem Token ein', async () => {
    await db.query('BEGIN');
    try {
      // Vorheriger Schemastand: ohne Statusspalten, UPDATE vollständig gesperrt.
      await db.query(`
        DROP TRIGGER audit_archive_guard_update ON public.audit_archive;
        DROP FUNCTION app.audit_archive_guard_update();
        DROP INDEX public.audit_archive_tsa_pending_idx;
        ALTER TABLE public.audit_archive DROP COLUMN tsa_status, DROP COLUMN tsa_stamped_at;
        CREATE TRIGGER audit_archive_no_update BEFORE UPDATE ON public.audit_archive
          FOR EACH ROW EXECUTE FUNCTION app.audit_archive_block_mutation();
      `);
      const legacy = `
        INSERT INTO public.audit_archive
          (tenant_id, from_audit_id, to_audit_id, from_occurred_at, to_occurred_at, entry_count,
           first_prev_hash, last_this_hash, file_sha256, file_size_bytes, storage_bucket,
           storage_key, tsa_response_blob)
        VALUES ($1::uuid, $2::bigint, $2::bigint + 9, now(), now(), 10, '\\x00', '\\x01', '\\x02',
                100, 'gobd', 'k' || $2::text, $3::bytea)
        RETURNING id`;
      const withoutToken = (await db.query(legacy, [tenantId, 1, null])).rows[0].id;
      const withToken = (await db.query(legacy, [tenantId, 11, Buffer.from('token')])).rows[0].id;

      await db.query(withoutTransaction(migration));

      const rows = await db.query(
        'SELECT id, tsa_status, tsa_stamped_at FROM public.audit_archive WHERE id = ANY($1)',
        [[withoutToken, withToken]],
      );
      const byId = new Map(rows.rows.map((row) => [String(row.id), row]));
      expect(byId.get(String(withoutToken))).toMatchObject({
        tsa_status: 'PENDING',
        tsa_stamped_at: null,
      });
      expect(byId.get(String(withToken))).toMatchObject({
        tsa_status: 'STAMPED',
        tsa_stamped_at: null,
      });
      // Nach der Migration gilt wieder nur der Nachstempel-Übergang.
      await expectRejected(
        `UPDATE public.audit_archive SET tsa_status = 'STAMPED' WHERE id = $1`,
        [withToken],
        /insert-only/,
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
