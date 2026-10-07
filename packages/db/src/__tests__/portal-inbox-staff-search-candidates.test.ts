// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
//
// Review-Finding P-10 (Folgepunkt Posteingangssuche): Stufe 1 der Staff-Suche im
// Mandanten-Posteingang. app.portal_inbox_staff_search_candidates findet die
// Treffer über den Trigram-Index, den dieselbe Bedingung unter RLS nicht nutzen
// darf. Geprüft werden die enge SECURITY-DEFINER-Grenze (Tenant nur aus dem
// Kontext, nur Kanzleipersonen mit PORTAL_INBOX_MANAGE, nur App-Rolle), dass sie
// nie mehr liefert als die Staff-Policy sichtbar macht, dieselben Treffer wie
// die bisherige Prisma-Suche unter RLS (gleiches Muster, gleiche Felder) und der
// Überlauf.
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const SIGNATURE = 'app.portal_inbox_staff_search_candidates(text,integer)';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261007160200_portal_inbox_staff_search_candidates/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Posteingangs-Kandidatensuche: Migration', () => {
  it('definiert eine enge SECURITY-DEFINER-Funktion ohne Tenant-Parameter', () => {
    expect(migrationSql).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/);
    expect(migrationSql).toContain('SET row_security = off');
    expect(migrationSql).toContain('v_tenant_id UUID := app.current_tenant_id();');
    expect(migrationSql).not.toMatch(/p_tenant/i);
    // Dieselben Teilbedingungen wie app.portal_inbox_staff_access
    // (Policy portal_inbox_thread_staff_select).
    expect(migrationSql).toContain("app.current_actor_type() IS DISTINCT FROM 'STAFF'");
    expect(migrationSql).toContain(
      "app.expansion_staff_permission(v_tenant_id, app.current_actor_id(), 'PORTAL_INBOX_MANAGE')",
    );
    expect(migrationSql.replace(/\s+/g, ' ')).toContain(
      'app.notification_staff_can_access_client( v_tenant_id, app.current_actor_id(), mandant.client_id )',
    );
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION app.portal_inbox_staff_search_candidates(TEXT, INTEGER) FROM PUBLIC;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION app.portal_inbox_staff_search_candidates(TEXT, INTEGER) TO taxtronik_app;',
    );
    // Parität der Owner-Rolle (owner-role-privileges.test.ts).
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION app.portal_inbox_staff_search_candidates(TEXT, INTEGER) TO taxtronik_owner;',
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Posteingangs-Kandidatensuche braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId = '';
let foreignTenantId = '';
const staff = { admin: '', mitarbeiter: '', ohneRecht: '' };
const clients = { alpha: '', vertraulich: '', beta: '' };
const contacts: Record<string, string> = {};
let foreignThreadId = '';
const threads: Record<string, string> = {};

type Actor = { id: string | null; type: 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM' };

function asActor<T>(tenant: string | null, actor: Actor, work: (tx: TxClient) => Promise<T>) {
  return app.$transaction(async (tx) => {
    if (tenant !== null) {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true),
        set_config('app.current_actor_id', ${actor.id ?? ''}, true),
        set_config('app.current_actor_type', ${actor.type}, true)`;
    }
    return work(tx as TxClient);
  });
}

async function candidates(
  tx: TxClient,
  query: string | null,
  limit = 5000,
): Promise<{ ids: string[]; ueberlauf: boolean }> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT thread_id::text AS id, ueberlauf
      FROM app.portal_inbox_staff_search_candidates(${query}, ${limit}::int)
  `;
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])).sort(),
    ueberlauf: rows.some((row) => row.ueberlauf),
  };
}

/** Bisherige einstufige Suche der Staff-Liste (Felder aus inboxMetadataSearch) unter RLS. */
async function prismaTreffer(tx: TxClient, query: string): Promise<string[]> {
  const rows = await tx.portalInboxThread.findMany({
    where: {
      tenantId,
      OR: [
        { subject: { contains: query, mode: 'insensitive' } },
        { client: { name: { contains: query, mode: 'insensitive' } } },
        { client: { datevNo: { contains: query, mode: 'insensitive' } } },
        { client: { addisonNo: { contains: query, mode: 'insensitive' } } },
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (
    await owner.tenant.create({ data: { name: 'Posteingang', slug: `inbox-cand-${seed}` } })
  ).id;
  foreignTenantId = (
    await owner.tenant.create({ data: { name: 'Posteingang fremd', slug: `inbox-cand-f-${seed}` } })
  ).id;
  const person = async (tenant: string, name: string, role: 'ADMIN' | 'EMPLOYEE') =>
    (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${name}-${seed}@example.test`,
          fullName: name,
          passwordHash: 'synthetic',
          roles: { create: { role } },
        },
      })
    ).id;
  staff.admin = await person(tenantId, 'admin', 'ADMIN');
  staff.mitarbeiter = await person(tenantId, 'mitarbeiter', 'EMPLOYEE');
  staff.ohneRecht = await person(tenantId, 'ohne-recht', 'EMPLOYEE');
  await owner.staffPermission.create({
    data: { staffUserId: staff.mitarbeiter, permission: 'PORTAL_INBOX_MANAGE' },
  });
  const foreignAdmin = await person(foreignTenantId, 'fremd', 'ADMIN');

  const mandant = async (
    tenant: string,
    name: string,
    extra: { datevNo?: string; addisonNo?: string; vertraulich?: boolean } = {},
    verifiedBy = staff.admin,
  ) => {
    const id = (
      await owner.client.create({ data: { tenantId: tenant, kind: 'JURPERS', name, ...extra } })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId: tenant,
      clientId: id,
      verifiedBy,
      registerNumber: `HRB-${name.slice(0, 4)}-${seed}`,
    });
    await owner.client.update({ where: { id }, data: { allowActive: true } });
    contacts[id] = (
      await owner.clientContact.create({
        data: { tenantId: tenant, clientId: id, email: `k-${id}@example.test`, fullName: 'K' },
      })
    ).id;
    return id;
  };
  clients.alpha = await mandant(tenantId, 'Alpha Posteingang GmbH', {
    datevNo: '47110',
    addisonNo: 'AD-0815',
  });
  clients.vertraulich = await mandant(tenantId, 'Geheim Holding GmbH', { vertraulich: true });
  clients.beta = await mandant(tenantId, 'Beta Muster GmbH');
  const fremd = await mandant(foreignTenantId, 'Fremd GmbH', {}, foreignAdmin);

  const thread = (tenant: string, clientId: string, subject: string) =>
    owner.portalInboxThread
      .create({
        data: { tenantId: tenant, clientId, subject, createdByContactId: contacts[clientId]! },
      })
      .then((row) => row.id);
  threads['alphaBelege'] = await thread(tenantId, clients.alpha, 'Belege Fahrtenbuch 2025');
  threads['alphaFrage'] = await thread(tenantId, clients.alpha, 'Frage zur Lohnabrechnung');
  threads['geheim'] = await thread(tenantId, clients.vertraulich, 'Belege Fahrtenbuch geheim');
  threads['betaProzent'] = await thread(tenantId, clients.beta, 'Rabatt 50% Kassenbuch');
  threads['betaUnterstrich'] = await thread(tenantId, clients.beta, 'Vertrag kunde_1 Anlage');
  threads['betaBindestrich'] = await thread(tenantId, clients.beta, 'Vertrag kunde-1 Anlage');
  foreignThreadId = await thread(foreignTenantId, fremd, 'Belege Fahrtenbuch fremd');
});

afterAll(async () => {
  try {
    for (const tenant of [tenantId, foreignTenantId]) {
      if (!tenant) continue;
      await owner.portalInboxThread.deleteMany({ where: { tenantId: tenant } });
      await owner.tenant.delete({ where: { id: tenant } });
    }
  } finally {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
});

describeWithDatabase('Posteingangs-Kandidatensuche: Datenbank', () => {
  const admin = (): Actor => ({ id: staff.admin, type: 'STAFF' });
  const mitarbeiter = (): Actor => ({ id: staff.mitarbeiter, type: 'STAFF' });

  it('ist SECURITY DEFINER mit festem search_path und nur für App- und Owner-Rolle ausführbar', async () => {
    const rows = await owner.$queryRaw<
      Array<{
        secdef: boolean;
        config: string[];
        app: boolean;
        owner: boolean;
        publicExec: boolean;
      }>
    >`
      SELECT p.prosecdef AS secdef, p.proconfig AS config,
             has_function_privilege('taxtronik_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('taxtronik_owner', p.oid, 'EXECUTE') AS owner,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
             ) AS "publicExec"
        FROM pg_proc p
       WHERE p.oid = ${SIGNATURE}::regprocedure
    `;
    expect(rows[0]).toMatchObject({ secdef: true, app: true, owner: true, publicExec: false });
    expect(rows[0]?.config).toEqual(
      expect.arrayContaining([
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'plan_cache_mode=force_custom_plan',
      ]),
    );
  });

  it('liefert nur Threads des Tenants aus dem Kontext, ohne Kontext nichts', async () => {
    const own = await asActor(tenantId, admin(), (tx) => candidates(tx, 'fahrtenbuch'));
    expect(own).toEqual({
      ids: [threads['alphaBelege']!, threads['geheim']!].sort(),
      ueberlauf: false,
    });
    expect(own.ids).not.toContain(foreignThreadId);
    await expect(asActor(null, admin(), (tx) => candidates(tx, 'fahrtenbuch'))).resolves.toEqual({
      ids: [],
      ueberlauf: false,
    });
    // Fremder Tenant im Kontext: keine Zeile dieses Tenants und kein Recht.
    await expect(
      asActor(foreignTenantId, admin(), (tx) => candidates(tx, 'fahrtenbuch')),
    ).resolves.toEqual({ ids: [], ueberlauf: false });
  });

  it('entspricht in ihren Teilbedingungen der Staff-Policy des Posteingangs', async () => {
    const policy = await owner.$queryRaw<Array<{ body: string }>>`
      SELECT pg_get_functiondef('app.portal_inbox_staff_access(uuid,uuid)'::regprocedure) AS body
    `;
    const body = policy[0]!.body.replace(/\s+/g, ' ');
    expect(body).toContain('p_tenant_id = app.current_tenant_id()');
    expect(body).toContain("app.current_actor_type() = 'STAFF'");
    expect(body).toContain(
      "app.expansion_staff_permission( p_tenant_id, app.current_actor_id(), 'PORTAL_INBOX_MANAGE' )",
    );
    expect(body).toContain(
      'app.notification_staff_can_access_client( p_tenant_id, app.current_actor_id(), p_client_id )',
    );
    const policyDef = await owner.$queryRaw<Array<{ qual: string }>>`
      SELECT qual FROM pg_policies
       WHERE tablename = 'portal_inbox_thread' AND policyname = 'portal_inbox_thread_staff_select'
    `;
    expect(policyDef[0]?.qual).toBe('app.portal_inbox_staff_access(tenant_id, client_id)');
  });

  it('liefert nur Kanzleipersonen mit Posteingangsrecht und nur sichtbare Mandanten', async () => {
    // Mitarbeiter (OPEN-Modus): der vertrauliche Mandant bleibt verborgen.
    await expect(
      asActor(tenantId, mitarbeiter(), (tx) => candidates(tx, 'fahrtenbuch')),
    ).resolves.toEqual({ ids: [threads['alphaBelege']!], ueberlauf: false });
    for (const actor of [
      { id: staff.ohneRecht, type: 'STAFF' as const },
      { id: contacts[clients.alpha]!, type: 'CLIENT_CONTACT' as const },
      { id: null, type: 'SYSTEM' as const },
    ]) {
      await expect(
        asActor(tenantId, actor, (tx) => candidates(tx, 'fahrtenbuch')),
        actor.type,
      ).resolves.toEqual({ ids: [], ueberlauf: false });
    }
  });

  it('findet dieselben Threads wie die bisherige Suche unter RLS', async () => {
    const begriffe = [
      'fahrtenbuch',
      'BELEGE',
      'alpha posteingang',
      '4711',
      'ad-0815',
      'geheim',
      'muster',
      // LIKE-Metazeichen wirken wie im Prisma-`contains` (unverändertes Muster).
      '50%',
      'kunde_1',
      '%',
      'lohn%abrechnung',
      'nichts dergleichen',
    ];
    for (const actor of [admin(), mitarbeiter()]) {
      await asActor(tenantId, actor, async (tx) => {
        for (const begriff of begriffe) {
          const erwartet = await prismaTreffer(tx, begriff);
          const kandidaten = await candidates(tx, begriff);
          expect(kandidaten, `${actor.id} ${begriff}`).toEqual({
            ids: erwartet,
            ueberlauf: false,
          });
        }
      });
    }
    // Stichproben der Mustersemantik.
    await asActor(tenantId, admin(), async (tx) => {
      expect((await candidates(tx, 'kunde_1')).ids).toEqual(
        [threads['betaUnterstrich']!, threads['betaBindestrich']!].sort(),
      );
      expect((await candidates(tx, '4711')).ids).toEqual(
        [threads['alphaBelege']!, threads['alphaFrage']!].sort(),
      );
    });
  });

  it('meldet einen Überlauf ohne IDs, wenn mehr Treffer als die Grenze vorliegen', async () => {
    await asActor(tenantId, admin(), async (tx) => {
      // Sechs Threads im Tenant treffen „a“; Grenze 5.
      const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
        SELECT thread_id::text AS id, ueberlauf
          FROM app.portal_inbox_staff_search_candidates('a', 5)
      `;
      expect(rows).toEqual([{ id: null, ueberlauf: true }]);
      expect(await candidates(tx, 'a', 6)).toMatchObject({ ueberlauf: false });
      expect((await candidates(tx, 'a', 6)).ids).toHaveLength(6);
      // Untergrenze 1, kein Suchbegriff: keine Zeile.
      expect(await candidates(tx, 'fahrtenbuch geheim', 0)).toEqual({
        ids: [threads['geheim']!],
        ueberlauf: false,
      });
      expect(await candidates(tx, null)).toEqual({ ids: [], ueberlauf: false });
    });
  });

  it('nutzt den Trigram-Index, den dieselbe Bedingung unter RLS nicht nutzen darf', async () => {
    // Genug Tenant-Zeilen, dass ein seltener Begriff über den Trigram-Index
    // billiger ist als jeder Tenant-B-Tree.
    await owner.$executeRaw`
      INSERT INTO public.portal_inbox_thread (tenant_id, client_id, subject, created_by_contact_id)
      SELECT ${tenantId}::uuid, ${clients.beta}::uuid, 'Füllthread ' || g, ${contacts[clients.beta]!}::uuid
        FROM generate_series(1, 5000) AS g
    `;
    const rare = (
      await owner.portalInboxThread.create({
        data: {
          tenantId,
          clientId: clients.beta,
          subject: 'Zylinderkopfdichtung Werkstatt',
          createdByContactId: contacts[clients.beta]!,
        },
      })
    ).id;
    await owner.$queryRaw`SELECT gin_clean_pending_list('public.portal_inbox_thread_subject_trgm_idx'::regclass)`;
    await owner.$executeRawUnsafe('ANALYZE public.portal_inbox_thread');
    const scans = (tx: TxClient) =>
      tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT pg_stat_get_xact_numscans('public.portal_inbox_thread_subject_trgm_idx'::regclass) AS n
      `.then((rows) => Number(rows[0]?.n ?? 0));
    await asActor(tenantId, admin(), async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const start = await scans(tx);
      const direct = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM public.portal_inbox_thread WHERE subject ILIKE '%zylinderkopf%'
      `;
      expect(direct.map((row) => row.id)).toEqual([rare]);
      const afterRls = await scans(tx);
      expect(afterRls - start).toBe(0);
      expect(await candidates(tx, 'zylinderkopf')).toEqual({ ids: [rare], ueberlauf: false });
      expect((await scans(tx)) - afterRls).toBeGreaterThan(0);
    });
  });
});
