// Fachkatalog: AUDIT-VERIFY-ALERT-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// P-04: Prüf-Checkpoints der Audit-Kettenprüfung sind abgeleiteter, aber
// sicherheitsrelevanter Zustand. Ein vorgeschobener Checkpoint würde Einträge bis
// zur nächsten Vollprüfung von der täglichen Nachrechnung ausnehmen. Deshalb
// schreibt nur der Owner (Worker); die App-Rolle liest tenantgebunden.
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261004140000_audit_verify_checkpoint/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Prüf-Checkpoint: Migration', () => {
  it('entzieht der App-Rolle alle Rechte außer SELECT und erzwingt RLS', () => {
    expect(migrationSql).toContain(
      'REVOKE ALL ON TABLE public."audit_verify_checkpoint" FROM taxtronik_app;',
    );
    expect(migrationSql).toContain(
      'REVOKE ALL ON TABLE public."audit_verify_checkpoint" FROM PUBLIC;',
    );
    expect(migrationSql).toContain(
      'GRANT SELECT ON TABLE public."audit_verify_checkpoint" TO taxtronik_app;',
    );
    expect(migrationSql).not.toMatch(/GRANT\s+(?!SELECT ON)/);
    expect(migrationSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Prüf-Checkpoint-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

const HASH = Buffer.alloc(32, 7);
const SWEEP = '00000000-0000-4000-8000-00000000f011';
let tenantA: string;
let tenantB: string;

async function insertCheckpoint(
  tenantId: string,
  overrides: Partial<
    Record<'kind' | 'auditHash' | 'auditId' | 'trust' | 'mac' | 'findings' | 'sweep', unknown>
  > = {},
): Promise<void> {
  const kind = overrides.kind ?? 'INCREMENTAL';
  const sweep = 'sweep' in overrides ? overrides.sweep : kind === 'INCREMENTAL' ? null : SWEEP;
  await owner.$executeRaw`
    INSERT INTO audit_verify_checkpoint (
      tenant_id, kind, audit_id, audit_hash, audit_count, seal_id, seals_checked,
      seals_trust_anchored, anchor_id, anchor_hash, anchor_top_audit_id,
      anchors_checked, anchors_trust_anchored, findings, sweep_id, mac
    ) VALUES (
      ${tenantId}::uuid, ${kind}, ${overrides.auditId ?? 5},
      ${overrides.auditHash ?? HASH}, 5, 0, 0, NULL, 0, ${HASH}, 0, 1,
      ${overrides.trust ?? 1}, ${overrides.findings ?? '{}'}::jsonb, ${sweep}::uuid,
      ${overrides.mac ?? HASH}
    )
  `;
}

async function asStaffOf<T>(tenantId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_type', 'STAFF', true)
    `;
    return work(tx);
  });
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantA = (
    await owner.tenant.create({ data: { name: 'Checkpoint A', slug: `checkpoint-a-${seed}` } })
  ).id;
  tenantB = (
    await owner.tenant.create({ data: { name: 'Checkpoint B', slug: `checkpoint-b-${seed}` } })
  ).id;
  await insertCheckpoint(tenantA);
  await insertCheckpoint(tenantB);
});

afterAll(async () => {
  if (hasDatabase) {
    // ON DELETE CASCADE: abgeleiteter Prüfzustand blockiert das Löschen nicht.
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('Prüf-Checkpoint: Rechte und Mandantentrennung', () => {
  it('gewährt der App-Rolle nur SELECT und erzwingt RLS', async () => {
    const rows = await owner.$queryRaw<
      Array<{ can_select: boolean; can_write: boolean; rls: boolean; forced: boolean }>
    >`
      SELECT
        has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'SELECT')
          AS can_select,
        has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write,
        c.relrowsecurity AS rls,
        c.relforcerowsecurity AS forced
      FROM pg_catalog.pg_class c
      WHERE c.oid = 'public.audit_verify_checkpoint'::regclass
    `;
    expect(rows).toEqual([{ can_select: true, can_write: false, rls: true, forced: true }]);
  });

  it('liest im Tenant-Kontext nur den eigenen Checkpoint', async () => {
    const visible = await asStaffOf(
      tenantA,
      (tx) =>
        tx.$queryRaw<Array<{ tenant_id: string }>>`
        SELECT tenant_id::text FROM audit_verify_checkpoint
      `,
    );
    expect(visible).toEqual([{ tenant_id: tenantA }]);
  });

  it.each([
    [
      'INSERT',
      (tx: TxClient) =>
        tx.$executeRaw`
          INSERT INTO audit_verify_checkpoint (
            tenant_id, kind, audit_id, audit_hash, audit_count, seal_id, seals_checked,
            anchor_id, anchor_hash, anchor_top_audit_id, anchors_checked, anchors_trust_anchored,
            findings, sweep_id, mac
          ) VALUES (${tenantA}::uuid, 'FULL', 0, ${HASH}, 0, 0, 0, 0, ${HASH}, 0, 0, 0,
                    '{}'::jsonb, ${SWEEP}::uuid, ${HASH})
        `,
    ],
    [
      'UPDATE',
      (tx: TxClient) =>
        tx.$executeRaw`UPDATE audit_verify_checkpoint SET audit_id = audit_id + 100`,
    ],
    ['DELETE', (tx: TxClient) => tx.$executeRaw`DELETE FROM audit_verify_checkpoint`],
  ])('verweigert der App-Rolle %s', async (_operation, write) => {
    await expect(asStaffOf(tenantA, write)).rejects.toThrow(/permission denied/i);
    const rows = await owner.$queryRaw<Array<{ audit_id: bigint }>>`
      SELECT audit_id FROM audit_verify_checkpoint WHERE tenant_id = ${tenantA}::uuid
    `;
    expect(rows).toEqual([{ audit_id: 5n }]);
  });

  it.each([
    ['unbekannte Art', { kind: 'OTHER' }, /audit_verify_checkpoint_kind_check/],
    ['verkürzter Hash', { kind: 'FULL', auditHash: Buffer.alloc(31) }, /hash_length_check/],
    ['negative Audit-ID', { kind: 'FULL', auditId: -1 }, /position_check/],
    ['Trust-Zähler über Prüfzähler', { kind: 'FULL', trust: 2 }, /position_check/],
    ['verkürzte Prüfsumme', { kind: 'FULL', mac: Buffer.alloc(31) }, /mac_length_check/],
    ['Befundliste ohne Objekt', { kind: 'FULL', findings: '[]' }, /findings_check/],
    ['Vollprüfung ohne Kennung', { kind: 'FULL', sweep: null }, /sweep_check/],
    ['Zielstand ohne Kennung', { kind: 'FULL_TARGET', sweep: null }, /sweep_check/],
  ])('lehnt %s ab', async (_case, overrides, constraint) => {
    await expect(insertCheckpoint(tenantB, overrides)).rejects.toThrow(constraint);
  });

  it('erlaubt im Zuwachs-Checkpoint die Kennung der laufenden Vollprüfung', async () => {
    const bind = (sweep: string | null) => owner.$executeRaw`
      UPDATE audit_verify_checkpoint SET sweep_id = ${sweep}::uuid
      WHERE tenant_id = ${tenantB}::uuid AND kind = 'INCREMENTAL'
    `;
    await expect(bind(SWEEP)).resolves.toBe(1);
    await expect(bind(null)).resolves.toBe(1);
  });
});
