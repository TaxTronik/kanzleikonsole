// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: PORTAL-INBOX-SUBMISSION-001
//
// Review-Finding P-10, Folgepunkt Welle 15: Stufe 1 der Suche im Posteingang
// des Mandantenportals. app.portal_inbox_contact_search_candidates findet die
// Treffer über portal_inbox_thread_subject_trgm_idx, den dieselbe Bedingung
// unter RLS nicht nutzen darf. Geprüft werden die enge SECURITY-DEFINER-Grenze
// (Tenant und Kontakt nur aus dem Kontext, der Mandant nur aus dem Kontakt,
// dieselben Bedingungen wie die Kontakt-Policy, nur App- und Owner-Rolle),
// dass ein Portalnutzer nie Threads anderer Mandanten oder Tenants erhält,
// dieselben Treffer in derselben Reihenfolge wie die bisherige Portalliste
// unter RLS (Betreff und eigener Mandantenname, keine internen Kennungen,
// Thema, Status, Zug), Grenze mit Überlauf und die Nutzung des Index.
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const SIGNATURE = 'app.portal_inbox_contact_search_candidates(text,text,text,text,integer)';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261012120200_portal_inbox_contact_search_candidates/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Portal-Kandidatensuche: Migration', () => {
  it('definiert eine enge SECURITY-DEFINER-Funktion ohne Tenant-, Kontakt- oder Mandant-Parameter', () => {
    expect(migrationSql).toMatch(/SECURITY DEFINER\s+SET search_path TO 'pg_catalog', 'pg_temp'/);
    expect(migrationSql).toContain("SET row_security TO 'off'");
    expect(migrationSql).toContain('v_tenant_id UUID := app.current_tenant_id();');
    expect(migrationSql).toContain('v_actor_id UUID := app.current_actor_id();');
    expect(migrationSql).not.toMatch(/p_tenant|p_actor|p_contact|p_client/i);
    expect(migrationSql).toContain("app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'");
    // Keine internen Kanzleikennungen als Suchfeld des Portals.
    expect(migrationSql).not.toMatch(/datev_no|addison_no|vat_id/);
    const signature = 'app.portal_inbox_contact_search_candidates(TEXT, TEXT, TEXT, TEXT, INTEGER)';
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO taxtronik_app;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO taxtronik_owner;`);
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Portal-Kandidatensuche braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

type Topic = 'GENERAL' | 'DOCUMENTS' | 'BILLING' | 'APPOINTMENT' | 'OTHER';
interface Filter {
  topic?: Topic;
  status?: 'OPEN' | 'RESOLVED';
  attention?: 'STAFF' | 'CLIENT' | 'NONE';
}

let tenantId = '';
let foreignTenantId = '';
let adminId = '';
const clients = { alpha: '', beta: '', beendet: '', fremd: '' };
const contacts = { alpha: '', alphaInaktiv: '', beta: '', beendet: '', fremd: '' };
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

const kontakt = (id: string): Actor => ({ id, type: 'CLIENT_CONTACT' });

async function candidates(
  tx: TxClient,
  query: string | null,
  filter: Filter = {},
  limit = 1000,
): Promise<{ ids: string[]; ueberlauf: boolean }> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT thread_id::text AS id, ueberlauf
      FROM app.portal_inbox_contact_search_candidates(
        ${query}, ${filter.topic ?? null}::text, ${filter.status ?? null}::text,
        ${filter.attention ?? null}::text, ${limit}::int
      )
  `;
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    ueberlauf: rows.some((row) => row.ueberlauf),
  };
}

/** Bisherige einstufige Portalliste (queries.ts, Felder aus inboxMetadataSearch) unter RLS. */
async function bisherigePortalliste(
  tx: TxClient,
  clientId: string,
  query: string,
  filter: Filter,
): Promise<string[]> {
  const where: Prisma.PortalInboxThreadWhereInput = {
    tenantId,
    clientId,
    ...(filter.topic ? { topic: filter.topic } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.attention ? { attention: filter.attention } : {}),
    OR: [
      { subject: { contains: query, mode: 'insensitive' } },
      { client: { name: { contains: query, mode: 'insensitive' } } },
    ],
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
    await owner.tenant.create({ data: { name: 'Portalsuche', slug: `portal-search-${seed}` } })
  ).id;
  foreignTenantId = (
    await owner.tenant.create({
      data: { name: 'Portalsuche fremd', slug: `portal-search-f-${seed}` },
    })
  ).id;
  for (const tenant of [tenantId, foreignTenantId]) {
    await owner.tenantSetting.create({
      data: { tenantId: tenant, key: 'portal.features', value: { clientInbox: true } },
    });
  }
  const person = async (tenant: string, name: string) =>
    (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${name}-${seed}@example.test`,
          fullName: name,
          passwordHash: 'synthetic',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
  adminId = await person(tenantId, 'admin');
  const foreignAdmin = await person(foreignTenantId, 'fremd');

  const mandant = async (
    tenant: string,
    name: string,
    extra: { datevNo?: string; addisonNo?: string } = {},
    verifiedBy = adminId,
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
    return id;
  };
  const kontaktAnlegen = async (tenant: string, clientId: string, name: string, active = true) =>
    (
      await owner.clientContact.create({
        data: {
          tenantId: tenant,
          clientId,
          email: `${name}-${seed}@example.test`,
          fullName: name,
          active,
        },
      })
    ).id;
  clients.alpha = await mandant(tenantId, 'Alpha Portal GmbH', {
    datevNo: '47110',
    addisonNo: 'AD-0815',
  });
  clients.beta = await mandant(tenantId, 'Beta Muster GmbH');
  clients.beendet = await mandant(tenantId, 'Beendet GmbH');
  clients.fremd = await mandant(foreignTenantId, 'Fremd GmbH', {}, foreignAdmin);
  contacts.alpha = await kontaktAnlegen(tenantId, clients.alpha, 'alpha');
  contacts.alphaInaktiv = await kontaktAnlegen(tenantId, clients.alpha, 'alpha-inaktiv', false);
  contacts.beta = await kontaktAnlegen(tenantId, clients.beta, 'beta');
  contacts.beendet = await kontaktAnlegen(tenantId, clients.beendet, 'beendet');
  contacts.fremd = await kontaktAnlegen(foreignTenantId, clients.fremd, 'fremd');

  let minute = 0;
  const thread = async (
    tenant: string,
    clientId: string,
    contactId: string,
    subject: string,
    extra: { topic?: Topic; resolved?: boolean; attention?: 'STAFF' | 'CLIENT' } = {},
  ) => {
    minute += 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, minute));
    return (
      await owner.portalInboxThread.create({
        data: {
          tenantId: tenant,
          clientId,
          subject,
          createdByContactId: contactId,
          createdAt: at,
          lastMessageAt: at,
          ...(extra.topic ? { topic: extra.topic } : {}),
          ...(extra.resolved
            ? {
                status: 'RESOLVED',
                attention: 'NONE',
                resolvedAt: at,
                resolvedByStaffId: tenant === tenantId ? adminId : foreignAdmin,
              }
            : extra.attention
              ? { attention: extra.attention }
              : {}),
        },
      })
    ).id;
  };
  threads['alphaBelege'] = await thread(
    tenantId,
    clients.alpha,
    contacts.alpha,
    'Belege Fahrtenbuch 2025',
    { topic: 'DOCUMENTS' },
  );
  threads['alphaFrage'] = await thread(
    tenantId,
    clients.alpha,
    contacts.alpha,
    'Frage zur Lohnabrechnung',
    { attention: 'CLIENT' },
  );
  threads['alphaProzent'] = await thread(
    tenantId,
    clients.alpha,
    contacts.alpha,
    'Rabatt 50% Rechnung',
    { topic: 'BILLING', resolved: true },
  );
  threads['alphaUnterstrich'] = await thread(
    tenantId,
    clients.alpha,
    contacts.alpha,
    'Vertrag kunde_1',
  );
  threads['alphaBindestrich'] = await thread(
    tenantId,
    clients.alpha,
    contacts.alpha,
    'Vertrag kunde-1',
  );
  // Gleicher Betreff bei einem anderen Mandanten desselben Tenants und in einem
  // fremden Tenant: für Kontakt alpha nie sichtbar.
  threads['betaBelege'] = await thread(
    tenantId,
    clients.beta,
    contacts.beta,
    'Belege Fahrtenbuch 2025',
    { topic: 'DOCUMENTS' },
  );
  threads['beendetBelege'] = await thread(
    tenantId,
    clients.beendet,
    contacts.beendet,
    'Belege Fahrtenbuch beendet',
  );
  threads['fremdBelege'] = await thread(
    foreignTenantId,
    clients.fremd,
    contacts.fremd,
    'Belege Fahrtenbuch 2025',
  );
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

describeWithDatabase('Portal-Kandidatensuche: Datenbank', () => {
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

  it('entspricht in ihren Bedingungen der Kontakt-Policy des Posteingangs', async () => {
    const policy = await owner.$queryRaw<Array<{ body: string }>>`
      SELECT pg_get_functiondef('app.portal_inbox_contact_access(uuid,uuid)'::regprocedure) AS body
    `;
    const body = policy[0]!.body.replace(/\s+/g, ' ');
    for (const fragment of [
      'p_tenant_id = app.current_tenant_id()',
      "app.current_actor_type() = 'CLIENT_CONTACT'",
      'contact.id = app.current_actor_id()',
      'AND contact.active',
      'AND client.allow_active',
      'AND client.mandate_ended_at IS NULL',
      'AND client.anonymized_at IS NULL',
      "AND setting.value ->> 'clientInbox' = 'true'",
    ]) {
      expect(body).toContain(fragment);
    }
    const policyDef = await owner.$queryRaw<Array<{ qual: string }>>`
      SELECT qual FROM pg_policies
       WHERE tablename = 'portal_inbox_thread' AND policyname = 'portal_inbox_thread_contact_select'
    `;
    expect(policyDef[0]?.qual).toBe('app.portal_inbox_contact_access(tenant_id, client_id)');
  });

  it('liefert nie Threads anderer Mandanten oder Tenants', async () => {
    await asActor(tenantId, kontakt(contacts.alpha), async (tx) => {
      expect(await candidates(tx, 'fahrtenbuch')).toEqual({
        ids: [threads['alphaBelege']!],
        ueberlauf: false,
      });
      // Begriff passt auf den eigenen Mandantennamen: alle eigenen Threads,
      // keiner eines anderen Mandanten.
      const eigene = await candidates(tx, 'alpha portal');
      expect(eigene.ids.sort()).toEqual(
        [
          threads['alphaBelege']!,
          threads['alphaFrage']!,
          threads['alphaProzent']!,
          threads['alphaUnterstrich']!,
          threads['alphaBindestrich']!,
        ].sort(),
      );
      // Fremder Mandantenname trifft nichts.
      expect(await candidates(tx, 'beta muster')).toEqual({ ids: [], ueberlauf: false });
    });
    await asActor(tenantId, kontakt(contacts.beta), async (tx) => {
      expect(await candidates(tx, 'fahrtenbuch')).toEqual({
        ids: [threads['betaBelege']!],
        ueberlauf: false,
      });
    });
    // Kontakt eines fremden Tenants im eigenen Kontext und umgekehrt: nichts.
    await asActor(tenantId, kontakt(contacts.fremd), async (tx) => {
      expect(await candidates(tx, 'fahrtenbuch')).toEqual({ ids: [], ueberlauf: false });
    });
    await asActor(foreignTenantId, kontakt(contacts.alpha), async (tx) => {
      expect(await candidates(tx, 'fahrtenbuch')).toEqual({ ids: [], ueberlauf: false });
    });
    await asActor(foreignTenantId, kontakt(contacts.fremd), async (tx) => {
      expect(await candidates(tx, 'fahrtenbuch')).toEqual({
        ids: [threads['fremdBelege']!],
        ueberlauf: false,
      });
    });
  });

  it('liefert nur aktiven Kontakten mit aktivem Mandat und eingeschaltetem Nachrichtenfach', async () => {
    for (const [tenant, actor] of [
      [tenantId, kontakt(contacts.alphaInaktiv)],
      [tenantId, kontakt(contacts.beendet)],
      [tenantId, { id: adminId, type: 'STAFF' as const }],
      [tenantId, { id: null, type: 'SYSTEM' as const }],
      [null, kontakt(contacts.alpha)],
    ] as const) {
      await expect(
        asActor(tenant, actor, (tx) => candidates(tx, 'fahrtenbuch')),
        `${actor.type} ${actor.id}`,
      ).resolves.toEqual({ ids: [], ueberlauf: false });
    }
    // Nachrichtenfach aus: nichts, wieder an: Treffer.
    await owner.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: 'portal.features' } },
      data: { value: { clientInbox: false } },
    });
    try {
      await expect(
        asActor(tenantId, kontakt(contacts.alpha), (tx) => candidates(tx, 'fahrtenbuch')),
      ).resolves.toEqual({ ids: [], ueberlauf: false });
    } finally {
      await owner.tenantSetting.update({
        where: { tenantId_key: { tenantId, key: 'portal.features' } },
        data: { value: { clientInbox: true } },
      });
    }
  });

  it('findet dieselben Threads in derselben Reihenfolge wie die bisherige Portalliste unter RLS', async () => {
    const begriffe = [
      'fahrtenbuch',
      'BELEGE',
      'alpha portal',
      // Interne Kanzleikennungen sind im Portal kein Suchfeld.
      '4711',
      'ad-0815',
      'beta muster',
      // LIKE-Metazeichen wirken wie im Prisma-`contains` (unverändertes Muster).
      '50%',
      'kunde_1',
      '%',
      'lohn%abrechnung',
      'nichts dergleichen',
    ];
    const filter: Filter[] = [
      {},
      { topic: 'DOCUMENTS' },
      { status: 'RESOLVED' },
      { status: 'OPEN', attention: 'CLIENT' },
      { topic: 'BILLING', status: 'RESOLVED' },
    ];
    for (const [contactId, clientId] of [
      [contacts.alpha, clients.alpha],
      [contacts.beta, clients.beta],
    ] as const) {
      await asActor(tenantId, kontakt(contactId), async (tx) => {
        for (const begriff of begriffe) {
          for (const f of filter) {
            const erwartet = await bisherigePortalliste(tx, clientId, begriff, f);
            expect(
              await candidates(tx, begriff, f),
              `${contactId} ${begriff} ${JSON.stringify(f)}`,
            ).toEqual({ ids: erwartet, ueberlauf: false });
          }
        }
      });
    }
    await asActor(tenantId, kontakt(contacts.alpha), async (tx) => {
      expect((await candidates(tx, '4711')).ids).toEqual([]);
      expect((await candidates(tx, 'kunde_1')).ids).toEqual([
        threads['alphaBindestrich']!,
        threads['alphaUnterstrich']!,
      ]);
    });
  });

  it('liefert die jüngsten Treffer bis zur Grenze, meldet weitere und nutzt den Trigram-Index', async () => {
    await asActor(tenantId, kontakt(contacts.alpha), async (tx) => {
      const alle = await bisherigePortalliste(tx, clients.alpha, 'alpha', {});
      expect(alle).toHaveLength(5);
      expect(await candidates(tx, 'alpha', {}, 2)).toEqual({
        ids: alle.slice(0, 2),
        ueberlauf: true,
      });
      expect(await candidates(tx, 'alpha', {}, 5)).toEqual({ ids: alle, ueberlauf: false });
      expect(await candidates(tx, null)).toEqual({ ids: [], ueberlauf: false });
    });

    await owner.$executeRaw`
      INSERT INTO public.portal_inbox_thread (tenant_id, client_id, subject, created_by_contact_id)
      SELECT ${tenantId}::uuid, ${clients.alpha}::uuid, 'Füllthread ' || g, ${contacts.alpha}::uuid
        FROM generate_series(1, 5000) AS g
    `;
    const rare = (
      await owner.portalInboxThread.create({
        data: {
          tenantId,
          clientId: clients.alpha,
          subject: 'Zylinderkopfdichtung Werkstatt',
          createdByContactId: contacts.alpha,
        },
      })
    ).id;
    await owner.$queryRaw`SELECT gin_clean_pending_list('public.portal_inbox_thread_subject_trgm_idx'::regclass)`;
    await owner.$executeRawUnsafe('ANALYZE public.portal_inbox_thread');
    const scans = (tx: TxClient) =>
      tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT pg_stat_get_xact_numscans('public.portal_inbox_thread_subject_trgm_idx'::regclass) AS n
      `.then((rows) => Number(rows[0]?.n ?? 0));
    await asActor(tenantId, kontakt(contacts.alpha), async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const start = await scans(tx);
      // Bisherige Portalliste: ILIKE ist nicht LEAKPROOF, unter RLS kein
      // Indexscan, auch ohne Seqscan.
      expect(await bisherigePortalliste(tx, clients.alpha, 'zylinderkopf', {})).toEqual([rare]);
      const nachBisher = await scans(tx);
      expect(nachBisher - start).toBe(0);
      expect(await candidates(tx, 'zylinderkopf')).toEqual({ ids: [rare], ueberlauf: false });
      expect((await scans(tx)) - nachBisher).toBeGreaterThan(0);
    });
  });
});
