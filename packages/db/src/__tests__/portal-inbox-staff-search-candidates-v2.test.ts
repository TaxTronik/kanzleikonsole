// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
//
// Review-Finding P-10, Folgepunkt Welle 15: Stufe 1 der Staff-Suche im
// Mandanten-Posteingang bei sehr vielen Treffern.
// app.portal_inbox_staff_search_candidates_v2 liefert die jüngsten sichtbaren
// Treffer mit allen Listenfiltern bis zu einer Grenze und meldet weitere als
// Überlauf. Geprüft werden die enge SECURITY-DEFINER-Grenze (Tenant und
// Bearbeiter nur aus dem Kontext, nur Kanzleipersonen mit PORTAL_INBOX_MANAGE,
// nur App- und Owner-Rolle), dass sie nie mehr liefert als die Staff-Policy
// sichtbar macht, dieselben Treffer in derselben Reihenfolge wie die bisherige
// Listenabfrage unter RLS (Felder, Muster, Thema, Status, Zug, Arbeitsbereich,
// Mandatsstatus) und die Grenze mit Überlauf.
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const SIGNATURE = 'app.portal_inbox_staff_search_candidates_v2(text,text,text,text,text,integer)';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261012120000_portal_inbox_staff_search_recent/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Posteingangs-Kandidatensuche v2: Migration', () => {
  it('definiert eine enge SECURITY-DEFINER-Funktion ohne Tenant- oder Akteur-Parameter', () => {
    expect(migrationSql).toMatch(/SECURITY DEFINER\s+SET search_path TO 'pg_catalog', 'pg_temp'/);
    expect(migrationSql).toContain("SET row_security TO 'off'");
    expect(migrationSql).toContain('v_tenant_id UUID := app.current_tenant_id();');
    expect(migrationSql).toContain('v_actor_id UUID := app.current_actor_id();');
    expect(migrationSql).not.toMatch(/p_tenant|p_actor|p_staff/i);
    expect(migrationSql).toContain("app.current_actor_type() IS DISTINCT FROM 'STAFF'");
    expect(migrationSql).toContain(
      "app.expansion_staff_permission(v_tenant_id, v_actor_id, 'PORTAL_INBOX_MANAGE')",
    );
    expect(migrationSql).toContain(
      'app.notification_staff_can_access_client(v_tenant_id, v_actor_id, kandidat.client_id)',
    );
    const signature =
      'app.portal_inbox_staff_search_candidates_v2(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER)';
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO taxtronik_app;`);
    // Parität der Owner-Rolle (owner-role-privileges.test.ts).
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO taxtronik_owner;`);
    // Expand/Contract: Die Vorgängerfunktion bleibt für das Vorrelease bestehen.
    expect(migrationSql).not.toMatch(/DROP FUNCTION/i);
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

type Scope = 'mine' | 'team' | 'all';
type Topic = 'GENERAL' | 'DOCUMENTS' | 'BILLING' | 'APPOINTMENT' | 'OTHER';
interface Filter {
  topic?: Topic;
  status?: 'OPEN' | 'RESOLVED';
  attention?: 'STAFF' | 'CLIENT' | 'NONE';
  scope: Scope;
}

let tenantId = '';
let foreignTenantId = '';
const staff = { admin: '', mitarbeiter: '', ohneRecht: '' };
const clients = { alpha: '', vertraulich: '', beta: '', beendet: '' };
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
  filter: Filter,
  limit = 1000,
): Promise<{ ids: string[]; ueberlauf: boolean }> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT thread_id::text AS id, ueberlauf
      FROM app.portal_inbox_staff_search_candidates_v2(
        ${query}, ${filter.topic ?? null}::text, ${filter.status ?? null}::text,
        ${filter.attention ?? null}::text, ${filter.scope}::text, ${limit}::int
      )
  `;
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    ueberlauf: rows.some((row) => row.ueberlauf),
  };
}

/**
 * Bisherige einstufige Listenabfrage (queries.ts ohne Vorauswahl) unter RLS:
 * Suchfelder aus inboxMetadataSearch, Listenfilter, Arbeitsbereich und
 * Mandatsstatus; den Mandantenzugriff erzwingt hier die Staff-Policy.
 */
async function bisherigeListe(
  tx: TxClient,
  actorId: string,
  query: string,
  filter: Filter,
): Promise<string[]> {
  const where: Prisma.PortalInboxThreadWhereInput = {
    tenantId,
    ...(filter.topic ? { topic: filter.topic } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.attention ? { attention: filter.attention } : {}),
    OR: [
      { subject: { contains: query, mode: 'insensitive' } },
      { client: { name: { contains: query, mode: 'insensitive' } } },
      { client: { datevNo: { contains: query, mode: 'insensitive' } } },
      { client: { addisonNo: { contains: query, mode: 'insensitive' } } },
    ],
    ...(filter.scope === 'mine'
      ? { assignedStaffId: actorId }
      : filter.scope === 'team'
        ? { assignedStaffId: null }
        : {}),
    client: { tenantId, allowActive: true, anonymizedAt: null, mandateEndedAt: null },
  };
  const rows = await tx.portalInboxThread.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (
    await owner.tenant.create({ data: { name: 'Posteingang v2', slug: `inbox-v2-${seed}` } })
  ).id;
  foreignTenantId = (
    await owner.tenant.create({
      data: { name: 'Posteingang v2 fremd', slug: `inbox-v2-f-${seed}` },
    })
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
  clients.beendet = await mandant(tenantId, 'Beendet Belege GmbH');
  const fremd = await mandant(foreignTenantId, 'Fremd GmbH', {}, foreignAdmin);

  let minute = 0;
  const thread = async (
    tenant: string,
    clientId: string,
    subject: string,
    extra: {
      topic?: Topic;
      resolved?: boolean;
      attention?: 'STAFF' | 'CLIENT';
      assignedStaffId?: string;
    } = {},
  ) => {
    minute += 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, minute));
    const resolvedBy = tenant === tenantId ? staff.admin : foreignAdmin;
    return (
      await owner.portalInboxThread.create({
        data: {
          tenantId: tenant,
          clientId,
          subject,
          createdByContactId: contacts[clientId]!,
          createdAt: at,
          lastMessageAt: at,
          ...(extra.topic ? { topic: extra.topic } : {}),
          ...(extra.assignedStaffId ? { assignedStaffId: extra.assignedStaffId } : {}),
          ...(extra.resolved
            ? {
                status: 'RESOLVED',
                attention: 'NONE',
                resolvedAt: at,
                resolvedByStaffId: resolvedBy,
              }
            : extra.attention
              ? { attention: extra.attention }
              : {}),
        },
      })
    ).id;
  };
  threads['alphaBelege'] = await thread(tenantId, clients.alpha, 'Belege Fahrtenbuch 2025', {
    topic: 'DOCUMENTS',
    assignedStaffId: staff.mitarbeiter,
  });
  threads['alphaFrage'] = await thread(tenantId, clients.alpha, 'Frage zur Lohnabrechnung', {
    attention: 'CLIENT',
  });
  threads['geheim'] = await thread(tenantId, clients.vertraulich, 'Belege Fahrtenbuch geheim', {
    topic: 'DOCUMENTS',
  });
  threads['betaProzent'] = await thread(tenantId, clients.beta, 'Rabatt 50% Kassenbuch', {
    topic: 'BILLING',
    assignedStaffId: staff.admin,
  });
  threads['betaUnterstrich'] = await thread(tenantId, clients.beta, 'Vertrag kunde_1 Anlage', {
    resolved: true,
  });
  threads['betaBindestrich'] = await thread(tenantId, clients.beta, 'Vertrag kunde-1 Anlage', {
    assignedStaffId: staff.mitarbeiter,
  });
  threads['betaBelegeErledigt'] = await thread(tenantId, clients.beta, 'Belege Quartal erledigt', {
    topic: 'DOCUMENTS',
    resolved: true,
    assignedStaffId: staff.mitarbeiter,
  });
  threads['beendet'] = await thread(tenantId, clients.beendet, 'Belege nach Mandatsende');
  foreignThreadId = await thread(foreignTenantId, fremd, 'Belege Fahrtenbuch fremd');
  // Mandatsende nach Anlage der Threads: die Liste blendet sie aus.
  await owner.client.update({
    where: { id: clients.beendet },
    data: { mandateEndedAt: new Date() },
  });
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

describeWithDatabase('Posteingangs-Kandidatensuche v2: Datenbank', () => {
  const admin = (): Actor => ({ id: staff.admin, type: 'STAFF' });
  const mitarbeiter = (): Actor => ({ id: staff.mitarbeiter, type: 'STAFF' });
  const alle: Filter = { scope: 'all' };

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
    const own = await asActor(tenantId, admin(), (tx) => candidates(tx, 'fahrtenbuch', alle));
    expect(own).toEqual({ ids: [threads['geheim']!, threads['alphaBelege']!], ueberlauf: false });
    expect(own.ids).not.toContain(foreignThreadId);
    await expect(
      asActor(null, admin(), (tx) => candidates(tx, 'fahrtenbuch', alle)),
    ).resolves.toEqual({ ids: [], ueberlauf: false });
    // Fremder Tenant im Kontext: keine Zeile dieses Tenants und kein Recht.
    await expect(
      asActor(foreignTenantId, admin(), (tx) => candidates(tx, 'fahrtenbuch', alle)),
    ).resolves.toEqual({ ids: [], ueberlauf: false });
  });

  it('liefert nur Kanzleipersonen mit Posteingangsrecht und nur sichtbare Mandanten', async () => {
    // Mitarbeiter (OPEN-Modus): der vertrauliche Mandant bleibt verborgen.
    await expect(
      asActor(tenantId, mitarbeiter(), (tx) => candidates(tx, 'fahrtenbuch', alle)),
    ).resolves.toEqual({ ids: [threads['alphaBelege']!], ueberlauf: false });
    for (const actor of [
      { id: staff.ohneRecht, type: 'STAFF' as const },
      { id: contacts[clients.alpha]!, type: 'CLIENT_CONTACT' as const },
      { id: null, type: 'SYSTEM' as const },
    ]) {
      await expect(
        asActor(tenantId, actor, (tx) => candidates(tx, 'fahrtenbuch', alle)),
        actor.type,
      ).resolves.toEqual({ ids: [], ueberlauf: false });
    }
  });

  it('bindet „Meine Arbeit“ an den Akteur des Kontexts und lehnt unbekannte Bereiche ab', async () => {
    const mine: Filter = { scope: 'mine' };
    await expect(
      asActor(tenantId, mitarbeiter(), (tx) => candidates(tx, 'belege', mine)),
    ).resolves.toEqual({
      ids: [threads['betaBelegeErledigt']!, threads['alphaBelege']!],
      ueberlauf: false,
    });
    await expect(
      asActor(tenantId, admin(), (tx) => candidates(tx, 'rabatt', mine)),
    ).resolves.toEqual({ ids: [threads['betaProzent']!], ueberlauf: false });
    await expect(
      asActor(tenantId, admin(), (tx) => candidates(tx, 'belege', mine)),
    ).resolves.toEqual({ ids: [], ueberlauf: false });
    for (const scope of ['', 'ALL', 'fremd'] as unknown as Scope[]) {
      await expect(
        asActor(tenantId, admin(), (tx) => candidates(tx, 'belege', { scope })),
      ).resolves.toEqual({ ids: [], ueberlauf: false });
    }
  });

  it('findet dieselben Threads in derselben Reihenfolge wie die bisherige Liste unter RLS', async () => {
    const begriffe = [
      'fahrtenbuch',
      'BELEGE',
      'alpha posteingang',
      '4711',
      'ad-0815',
      'geheim',
      'muster',
      'beendet',
      // LIKE-Metazeichen wirken wie im Prisma-`contains` (unverändertes Muster).
      '50%',
      'kunde_1',
      '%',
      'lohn%abrechnung',
      'nichts dergleichen',
    ];
    const filter: Filter[] = [
      { scope: 'all' },
      { scope: 'mine' },
      { scope: 'team' },
      { scope: 'all', topic: 'DOCUMENTS' },
      { scope: 'all', status: 'RESOLVED' },
      { scope: 'all', status: 'OPEN', attention: 'STAFF' },
      { scope: 'all', attention: 'CLIENT' },
      { scope: 'mine', topic: 'DOCUMENTS', status: 'RESOLVED' },
    ];
    for (const actor of [admin(), mitarbeiter()]) {
      await asActor(tenantId, actor, async (tx) => {
        for (const begriff of begriffe) {
          for (const f of filter) {
            const erwartet = await bisherigeListe(tx, actor.id!, begriff, f);
            expect(
              await candidates(tx, begriff, f),
              `${actor.id} ${begriff} ${JSON.stringify(f)}`,
            ).toEqual({ ids: erwartet, ueberlauf: false });
          }
        }
      });
    }
    // Stichproben: Mandatsende blendet aus, Mustersemantik wie bisher.
    await asActor(tenantId, admin(), async (tx) => {
      expect((await candidates(tx, 'beendet', alle)).ids).toEqual([]);
      expect((await candidates(tx, 'kunde_1', alle)).ids).toEqual([
        threads['betaBindestrich']!,
        threads['betaUnterstrich']!,
      ]);
    });
  });

  it('liefert die jüngsten Treffer bis zur Grenze und meldet weitere als Überlauf', async () => {
    await asActor(tenantId, admin(), async (tx) => {
      const alleTreffer = await bisherigeListe(tx, staff.admin, 'a', alle);
      expect(alleTreffer.length).toBeGreaterThan(3);
      expect(await candidates(tx, 'a', alle, 3)).toEqual({
        ids: alleTreffer.slice(0, 3),
        ueberlauf: true,
      });
      expect(await candidates(tx, 'a', alle, alleTreffer.length)).toEqual({
        ids: alleTreffer,
        ueberlauf: false,
      });
      // Untergrenze 1; kein Suchbegriff: keine Zeile.
      expect(await candidates(tx, 'a', alle, 0)).toEqual({
        ids: alleTreffer.slice(0, 1),
        ueberlauf: true,
      });
      expect(await candidates(tx, null, alle)).toEqual({ ids: [], ueberlauf: false });
    });
  });

  it('nutzt den Trigram-Index des Betreffs', async () => {
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
      expect(await candidates(tx, 'zylinderkopf', alle)).toEqual({ ids: [rare], ueberlauf: false });
      expect((await scans(tx)) - start).toBeGreaterThan(0);
    });
  });
});
