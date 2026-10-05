// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Review-Finding P-10: Stufe 1 der Kanzleisuche. app.staff_search_candidates
// liefert Kandidaten-IDs über die Trigram-Indizes, die unter RLS für ILIKE
// nicht nutzbar sind. Geprüft werden die enge SECURITY-DEFINER-Grenze (Tenant
// nur aus dem Kontext, begrenzte Menge, nur App-Rolle), die Suchsemantik wie
// Prisma `contains` und dass die Kandidatenabfrage den Trigram-Index nutzt.
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const SIGNATURE = 'app.staff_search_candidates(text,text,integer,integer)';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261005100100_staff_search_trigram_candidates/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Kandidatensuche: Migration', () => {
  it('definiert eine enge SECURITY-DEFINER-Funktion ohne Tenant-Parameter', () => {
    expect(migrationSql).toMatch(
      /SECURITY DEFINER\s+SET search_path = pg_catalog, public, pg_temp/,
    );
    expect(migrationSql).toContain('SET row_security = off');
    expect(migrationSql).toContain('v_tenant_id UUID := app.current_tenant_id();');
    expect(migrationSql).not.toMatch(/p_tenant/i);
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION app.staff_search_candidates(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION app.staff_search_candidates(TEXT, TEXT, INTEGER, INTEGER) TO taxtronik_app;',
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Kandidatensuche-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId: string;
let foreignTenantId: string;
let staffId: string;
let activeClientId: string;
let otherClientId: string;
let requestId: string;
let invoiceId: string;
const docs: Record<string, string> = {};
const bulkDocIds: string[] = [];
const BULK = 205;

async function withContext<T>(
  tenant: string | null,
  work: (tx: TxClient) => Promise<T>,
  setting?: string,
): Promise<T> {
  return app.$transaction(async (tx) => {
    if (tenant !== null || setting !== undefined) {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${setting ?? tenant}, true),
        set_config('app.current_actor_id', ${staffId}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
    }
    return work(tx as TxClient);
  });
}

async function candidates(
  tx: TxClient,
  kind: string,
  term: string | null,
  limit = 200,
  offset = 0,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT candidate_id::text AS id
      FROM app.staff_search_candidates(${kind}, ${term}, ${limit}::int, ${offset}::int)
  `;
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (await owner.tenant.create({ data: { name: 'Suche', slug: `search-cand-${seed}` } }))
    .id;
  foreignTenantId = (
    await owner.tenant.create({ data: { name: 'Suche fremd', slug: `search-cand-f-${seed}` } })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `search-cand-${seed}@example.test`,
        fullName: 'Suche',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  activeClientId = (
    await owner.client.create({
      data: {
        tenantId,
        kind: 'JURPERS',
        name: 'Alpha Trigrammhandel GmbH',
        datevNo: '47110',
        addisonNo: 'AD-0815',
        vatId: 'DE111222333',
      },
    })
  ).id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId,
    clientId: activeClientId,
    verifiedBy: staffId,
    registerNumber: `HRB-${seed}`,
  });
  await owner.client.update({ where: { id: activeClientId }, data: { allowActive: true } });
  otherClientId = (
    await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'Beta Muster' } })
  ).id;
  requestId = (
    await owner.request.create({
      data: {
        tenantId,
        clientId: activeClientId,
        title: 'Belege Q1',
        description: 'Bitte die Rückfrage zum Trigrammhandel beantworten.',
        createdByStaff: staffId,
      },
    })
  ).id;
  invoiceId = (
    await owner.invoice.create({
      data: {
        tenantId,
        clientId: activeClientId,
        number: `RE-TRGM-${seed}`,
        subject: 'Beratung',
        issueDate: new Date('2026-06-01'),
        dueDate: new Date('2026-07-01'),
        netAmount: 100,
        vatAmount: 19,
        totalAmount: 119,
        createdByStaff: staffId,
      },
    })
  ).id;
  const internal = (title: string, extra: Record<string, unknown> = {}, tenant = tenantId) =>
    owner.document.create({
      data: {
        tenantId: tenant,
        title,
        classification: 'GENERAL',
        mimeType: 'text/plain',
        ...extra,
      },
    });
  docs['underscore'] = (await internal('Vertrag kunde_1 Suchtest')).id;
  docs['dash'] = (await internal('Vertrag kunde-1 Suchtest')).id;
  docs['percent'] = (await internal('Rabatt 50% Suchtest')).id;
  docs['deleted'] = (await internal('Gelöscht Suchtest', { deletedAt: new Date() })).id;
  docs['foreign'] = (await internal('Vertrag kunde_1 Suchtest', {}, foreignTenantId)).id;
  for (let i = 0; i < BULK; i++) {
    const created = await owner.document.create({
      data: {
        tenantId,
        title: `Massenbeleg ${String(i).padStart(3, '0')}`,
        classification: 'GENERAL',
        mimeType: 'text/plain',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      },
    });
    bulkDocIds.push(created.id);
  }
});

afterAll(async () => {
  try {
    if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    if (foreignTenantId) await owner.tenant.delete({ where: { id: foreignTenantId } });
  } finally {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
});

describeWithDatabase('Kandidatensuche: Datenbank', () => {
  it('ist SECURITY DEFINER mit festem search_path und nur für die App-Rolle ausführbar', async () => {
    const rows = await owner.$queryRaw<
      Array<{ secdef: boolean; config: string[]; app: boolean; publicExec: boolean }>
    >`
      SELECT p.prosecdef AS secdef, p.proconfig AS config,
             has_function_privilege('taxtronik_app', p.oid, 'EXECUTE') AS app,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
             ) AS "publicExec"
        FROM pg_proc p
       WHERE p.oid = ${SIGNATURE}::regprocedure
    `;
    expect(rows[0]).toMatchObject({ secdef: true, app: true, publicExec: false });
    expect(rows[0]?.config).toEqual(
      expect.arrayContaining([
        'search_path=pg_catalog, public, pg_temp',
        'row_security=off',
        'plan_cache_mode=force_custom_plan',
      ]),
    );
  });

  it('liefert nur Zeilen des Tenants aus dem Kontext, ohne Kontext nichts', async () => {
    const own = await withContext(tenantId, (tx) => candidates(tx, 'document', 'kunde_1'));
    expect(own).toEqual([docs['underscore']]);
    const foreign = await withContext(foreignTenantId, (tx) =>
      candidates(tx, 'document', 'kunde_1'),
    );
    expect(foreign).toEqual([docs['foreign']]);
    await expect(withContext(null, (tx) => candidates(tx, 'document', 'kunde_1'))).resolves.toEqual(
      [],
    );
    // Auf einer Pool-Verbindung zurückgesetzter Kontext: leer, kein Cast-Fehler.
    await expect(
      withContext(null, (tx) => candidates(tx, 'document', 'kunde_1'), ''),
    ).resolves.toEqual([]);
  });

  it('sucht je Kategorie in denselben Feldern wie die Trefferliste', async () => {
    await withContext(tenantId, async (tx) => {
      for (const term of ['trigrammhandel', '4711', 'ad-0815', 'de111222']) {
        expect(await candidates(tx, 'client', term), term).toEqual([activeClientId]);
      }
      expect(await candidates(tx, 'client', 'beta')).toEqual([otherClientId]);
      expect(await candidates(tx, 'request', 'belege q1')).toEqual([requestId]);
      expect(await candidates(tx, 'request', 'RÜCKFRAGE')).toEqual([requestId]);
      expect(await candidates(tx, 'invoice', 're-trgm')).toEqual([invoiceId]);
      expect(await candidates(tx, 'invoice', 'beratung')).toEqual([invoiceId]);
      expect(await candidates(tx, 'document', 'gelöscht')).toEqual([]);
      expect(await candidates(tx, 'unbekannt', 'beta')).toEqual([]);
      expect(await candidates(tx, 'client', null)).toEqual([]);
    });
  });

  it('behandelt LIKE-Metazeichen wörtlich wie die escapten Prisma-Filter', async () => {
    await withContext(tenantId, async (tx) => {
      expect(await candidates(tx, 'document', '50%')).toEqual([docs['percent']]);
      expect(await candidates(tx, 'document', 'kunde_1')).toEqual([docs['underscore']]);
      expect((await candidates(tx, 'document', 'kunde-1')).sort()).toEqual([docs['dash']]);
      expect(await candidates(tx, 'document', '%')).toEqual([docs['percent']]);
    });
  });

  it('sortiert wie die Trefferliste und begrenzt Blockgröße und Offset', async () => {
    const newestFirst = [...bulkDocIds].reverse();
    await withContext(tenantId, async (tx) => {
      expect(await candidates(tx, 'document', 'massenbeleg', 3)).toEqual(newestFirst.slice(0, 3));
      expect(await candidates(tx, 'document', 'massenbeleg', 3, 3)).toEqual(
        newestFirst.slice(3, 6),
      );
      // Obergrenze 200 je Block, Untergrenze 1.
      expect(await candidates(tx, 'document', 'massenbeleg', 10_000)).toHaveLength(200);
      expect(await candidates(tx, 'document', 'massenbeleg', 0)).toHaveLength(1);
      expect(await candidates(tx, 'document', 'massenbeleg', 200, 200)).toEqual(
        newestFirst.slice(200),
      );
      // Offset ist auf 1.000 begrenzt; dahinter liegt hier nichts mehr.
      expect(await candidates(tx, 'document', 'massenbeleg', 200, 50_000)).toEqual([]);
    });
  });

  it('nutzt den Trigram-Index, den dieselbe Bedingung unter RLS nicht nutzen darf', async () => {
    // Genug Tenant-Zeilen, dass ein seltener Begriff über den Trigram-Index
    // billiger ist als jeder Tenant-B-Tree (sonst plant PostgreSQL bei kleinen
    // Testtabellen zu Recht anders).
    await owner.$executeRaw`
      INSERT INTO public.document (tenant_id, title, classification, mime_type, updated_at)
      SELECT ${tenantId}::uuid, 'Füllbeleg ' || g, 'GENERAL', 'text/plain', now()
        FROM generate_series(1, 5000) AS g
    `;
    const rare = (
      await owner.document.create({
        data: {
          tenantId,
          title: 'Zylinderkopfdichtung Werkstatt',
          classification: 'GENERAL',
          mimeType: 'text/plain',
        },
      })
    ).id;
    // Frisch eingefügte Zeilen liegen in der GIN-Pending-List, deren Scan der
    // Planer teuer bewertet; Autovacuum räumt sie im Betrieb ab.
    await owner.$queryRaw`SELECT gin_clean_pending_list('public.document_title_trgm_idx'::regclass)`;
    await owner.$executeRawUnsafe('ANALYZE public.document');
    const scans = (tx: TxClient) =>
      tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT pg_stat_get_xact_numscans('public.document_title_trgm_idx'::regclass) AS n
      `.then((rows) => Number(rows[0]?.n ?? 0));
    await withContext(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const start = await scans(tx);
      const direct = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM public.document WHERE title ILIKE '%zylinderkopf%'
      `;
      expect(direct.map((row) => row.id)).toEqual([rare]);
      const afterRls = await scans(tx);
      expect(afterRls - start).toBe(0);
      expect(await candidates(tx, 'document', 'zylinderkopf', 5)).toEqual([rare]);
      expect((await scans(tx)) - afterRls).toBeGreaterThan(0);
    });
  });
});
