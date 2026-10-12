// =============================================================================
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: ACCESS-CLIENT-MODE-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
//
// Review-Finding P-10, Folgepunkt Welle 15: Stufe 1 der Titelsuche der
// Dokumentenseite (/staff/documents). app.document_title_search_candidates
// findet die Treffer einer Ebene (Mandant oder Kanzlei-intern, Ordner,
// aktiv/gelöscht) über document_title_trgm_idx, den dieselbe Bedingung unter
// RLS nicht nutzen darf. Nachweise gegen PostgreSQL; die Fixtures liegen in
// einer zurückgerollten Transaktion (Mandatsartefakte sind nicht löschbar):
//  - enge SECURITY-DEFINER-Grenze: Tenant und Akteur nur aus dem Kontext, nur
//    aktive Kanzleipersonen, Mandantenzugriff wie canAccessClientTx, nur App-
//    und Owner-Rolle;
//  - dieselben Treffer in derselben Reihenfolge wie die bisherige Abfrage der
//    Seite unter RLS der App-Rolle (Lohn-Sperre, Mandatsartefakte, gelöschte,
//    Ordner, Kanzlei-intern, LIKE-Metazeichen) für ADMIN, Mitarbeiter mit und
//    ohne PAYROLL_MANAGE;
//  - Grenze mit Überlauf und Nutzung des Trigram-Index.
// =============================================================================

import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaClient as GeneratedPrismaClient } from '@prisma/client';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const SIGNATURE = 'app.document_title_search_candidates(uuid,uuid,boolean,text,integer)';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261012120100_document_title_search_candidates/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migrationSql = migration.replace(/--.*$/gm, '');

describe('Titelsuche der Dokumentenseite: Migration', () => {
  it('definiert eine enge SECURITY-DEFINER-Funktion ohne Tenant- oder Akteur-Parameter', () => {
    expect(migrationSql).toMatch(/SECURITY DEFINER\s+SET search_path TO 'pg_catalog', 'pg_temp'/);
    expect(migrationSql).toContain("SET row_security TO 'off'");
    expect(migrationSql).toContain('v_tenant_id UUID := app.current_tenant_id();');
    expect(migrationSql).toContain('v_actor_id UUID := app.current_actor_id();');
    expect(migrationSql).not.toMatch(/p_tenant|p_actor|p_staff/i);
    expect(migrationSql).toContain("app.current_actor_type() IS DISTINCT FROM 'STAFF'");
    // Teilbedingungen der RESTRICTIVE-Policies auf document.
    expect(migrationSql).toContain(
      "app.expansion_staff_permission(v_tenant_id, v_actor_id, 'PAYROLL_MANAGE')",
    );
    expect(migrationSql).toContain(
      'app.mandate_artifact_document_allowed(doc.tenant_id, doc.id::text)',
    );
    expect(migrationSql).toContain(
      'app.notification_staff_can_access_client(v_tenant_id, v_actor_id, p_client_id)',
    );
    const signature = 'app.document_title_search_candidates(UUID, UUID, BOOLEAN, TEXT, INTEGER)';
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO taxtronik_app;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO taxtronik_owner;`);
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Titelsuche der Dokumentenseite braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

afterAll(async () => {
  await db.$disconnect();
});

const ROLLBACK = new Error('rollback');

/** Führt alles in einer Transaktion aus und rollt sie danach immer zurück. */
async function inRollback(work: (tx: TxClient) => Promise<void>): Promise<void> {
  try {
    await db.$transaction(
      async (tx) => {
        await work(tx);
        throw ROLLBACK;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (error === ROLLBACK) return;
    throw error;
  }
  throw new Error('Fixture-Transaktion wurde nicht zurückgerollt.');
}

async function setActor(tx: TxClient, tenantId: string, actorId: string, actorType: string) {
  await tx.$queryRaw`
    SELECT set_config('app.current_tenant_id', ${tenantId}, true),
           set_config('app.current_actor_id', ${actorId}, true),
           set_config('app.current_actor_type', ${actorType}, true)
  `;
}

interface Scope {
  clientId: string | null;
  folderId: string | null;
  deleted: boolean;
}

/** Stufe 1 als App-Rolle. */
async function candidates(
  tx: TxClient,
  scope: Scope,
  query: string | null,
  limit = 1000,
): Promise<{ ids: string[]; ueberlauf: boolean }> {
  await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT document_id::text AS id, ueberlauf
      FROM app.document_title_search_candidates(
        ${scope.clientId}::uuid, ${scope.folderId}::uuid, ${scope.deleted}, ${query}, ${limit}::int
      )
  `;
  await tx.$executeRawUnsafe('RESET ROLE');
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    ueberlauf: rows.some((row) => row.ueberlauf),
  };
}

/** Bisherige einstufige Abfrage der Dokumentenseite unter RLS der App-Rolle. */
async function bisherigeAbfrage(
  tx: TxClient,
  tenantId: string,
  scope: Scope,
  query: string,
): Promise<string[]> {
  await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
  const rows = await tx.document.findMany({
    where: {
      tenantId,
      clientId: scope.clientId,
      folderId: scope.folderId,
      deletedAt: scope.deleted ? { not: null } : null,
      title: { contains: query, mode: 'insensitive' },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  await tx.$executeRawUnsafe('RESET ROLE');
  return rows.map((row) => row.id);
}

async function buildFixture(tx: TxClient) {
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = (await tx.tenant.create({ data: { slug: `p10-doc-${seed}`, name: 'P-10' } })).id;
  const foreignTenantId = (
    await tx.tenant.create({ data: { slug: `p10-doc-f-${seed}`, name: 'P-10 fremd' } })
  ).id;
  const staff = async (
    tenant: string,
    name: string,
    role: 'ADMIN' | 'EMPLOYEE',
    extra: { payroll?: boolean; active?: boolean } = {},
  ) =>
    (
      await tx.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${name}-${seed}@example.test`,
          fullName: name,
          passwordHash: 'synthetic',
          active: extra.active ?? true,
          roles: { create: { role } },
          ...(extra.payroll ? { permissions: { create: { permission: 'PAYROLL_MANAGE' } } } : {}),
        },
      })
    ).id;
  const adminId = await staff(tenantId, 'admin', 'ADMIN');
  const employeeId = await staff(tenantId, 'mitarbeiter', 'EMPLOYEE');
  const payrollId = await staff(tenantId, 'lohn', 'EMPLOYEE', { payroll: true });
  const inactiveId = await staff(tenantId, 'inaktiv', 'ADMIN', { active: false });
  const foreignAdminId = await staff(foreignTenantId, 'fremd', 'ADMIN');

  // Mandantendokumente setzen eine bestandene GwG-Schranke voraus. Der
  // Fixture-Helfer öffnet sonst eine eigene Transaktion.
  const inTransaction = { $transaction: (fn: (t: TxClient) => unknown) => fn(tx) };
  const mandant = async (name: string, vertraulich: boolean) => {
    const id = (await tx.client.create({ data: { tenantId, kind: 'JURPERS', name, vertraulich } }))
      .id;
    await createVerifiedLegalEntityGwgFixture(inTransaction as unknown as GeneratedPrismaClient, {
      tenantId,
      clientId: id,
      verifiedBy: adminId,
      registerNumber: `HRB ${name} ${seed}`,
    });
    await tx.client.update({ where: { id }, data: { allowActive: true } });
    return id;
  };
  const offen = await mandant('Offen GmbH', false);
  const vertraulich = await mandant('Vertraulich GmbH', true);
  const folder = async (clientId: string | null, name: string) =>
    (await tx.documentFolder.create({ data: { tenantId, clientId, name } })).id;
  const ordnerA = await folder(offen, 'Ordner A');
  const ordnerIntern = await folder(null, 'Intern I');

  let minute = 0;
  let fill = 0;
  const document = async (
    title: string,
    data: {
      tenantId?: string;
      clientId?: string | null;
      folderId?: string;
      deleted?: boolean;
      payroll?: boolean;
      hasMandateArtifact?: boolean;
      staffPrivate?: boolean;
    } = {},
  ) => {
    minute += 1;
    const created = await tx.document.create({
      data: {
        tenantId: data.tenantId ?? tenantId,
        clientId: data.clientId === undefined ? offen : data.clientId,
        folderId: data.folderId ?? null,
        title,
        classification: data.payroll
          ? 'PERSONNEL'
          : data.staffPrivate
            ? 'STAFF_PRIVATE'
            : 'GENERAL',
        requiresPayrollAccess: data.payroll ?? false,
        hasMandateArtifact: data.hasMandateArtifact ?? false,
        mimeType: 'application/pdf',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
        ...(data.deleted ? { deletedAt: new Date(), deleteReason: 'Test' } : {}),
      },
    });
    fill += 1;
    const sha256 = Buffer.alloc(32, fill);
    const version = await tx.documentVersion.create({
      data: {
        documentId: created.id,
        versionNo: 1,
        storageBucket: 'p10-test',
        storageKey: `p10-test/${created.id}/v1`,
        sha256,
        sizeBytes: 1n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: data.tenantId === foreignTenantId ? foreignAdminId : adminId,
      },
    });
    return { id: created.id, versionId: version.id, outputHash: sha256.toString('hex') };
  };

  const docs = {
    januar: (await document('Rechnung 2025 Januar')).id,
    februarGeloescht: (await document('Rechnung 2025 Februar', { deleted: true })).id,
    lohn: (await document('Lohnjournal Rechnung 2025', { payroll: true })).id,
    prozent: (await document('Rabatt 50% Rechnung')).id,
    unterstrich: (await document('kunde_1 Vertrag')).id,
    bindestrich: (await document('kunde-1 Vertrag')).id,
    markiert: (await document('Rechnung markiert ohne Artefakt', { hasMandateArtifact: true })).id,
    maerz: (await document('Rechnung 2025 März', { folderId: ordnerA })).id,
    geheim: (await document('Rechnung geheim', { clientId: vertraulich })).id,
    kanzlei: (await document('Rechnung Kanzlei', { clientId: null })).id,
    kanzleiOrdner: (
      await document('Rechnung Kanzlei Ordner', {
        clientId: null,
        folderId: ordnerIntern,
      })
    ).id,
    fremd: (await document('Rechnung fremd', { tenantId: foreignTenantId, clientId: null })).id,
    strukturbild: '',
  };
  // Mandatsartefakt mit ungültigen Quellen: app.mandate_artifact_document_allowed
  // verweigert das Dokument für alle Betrachter.
  const offboardingId = (
    await tx.mandateOffboarding.create({
      data: {
        tenantId,
        clientId: offen,
        endDate: new Date('2026-12-31T00:00:00.000Z'),
        sourceHash: 'p10-uebergabe',
        sourceSnapshot: {},
        handoverNote: '',
        retentionNote: '',
        createdBy: adminId,
        recipient: 'Nachfolgekanzlei Muster',
      },
    })
  ).id;
  const strukturbild = await document('Rechnung Strukturbild', { staffPrivate: true });
  const plainVersion = (
    await tx.documentVersion.findFirstOrThrow({ where: { documentId: docs.januar } })
  ).id;
  const artifactId = (
    await tx.mandateArtifact.create({
      data: {
        tenantId,
        clientId: offen,
        offboardingId,
        sourceKey: 'p10:invalid-sources',
        sourceHash: 'p10-invalid-sources',
        generatorVersion: 'p10-test/1',
        manifest: { snapshot: { documents: [{ versionId: plainVersion }] } },
        kind: 'OFFBOARDING',
        groupKey: 'invalid-sources',
        classification: 'STAFF_PRIVATE',
        createdBy: adminId,
      },
    })
  ).id;
  await tx.$executeRaw`
    UPDATE mandate_artifact
       SET status = 'PENDING',
           document_id = ${strukturbild.id}::uuid,
           document_version_id = ${strukturbild.versionId}::uuid,
           output_hash = ${strukturbild.outputHash}
     WHERE id = ${artifactId}::uuid
  `;
  docs.strukturbild = strukturbild.id;

  return {
    tenantId,
    foreignTenantId,
    adminId,
    employeeId,
    payrollId,
    inactiveId,
    foreignAdminId,
    clients: { offen, vertraulich },
    folders: { ordnerA, ordnerIntern },
    docs,
  };
}

describeWithDatabase('Titelsuche der Dokumentenseite: Datenbank', () => {
  it('ist SECURITY DEFINER mit festem search_path und nur für App- und Owner-Rolle ausführbar', async () => {
    const rows = await db.$queryRaw<
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

  it('entspricht in ihren Teilbedingungen den RESTRICTIVE-Policies auf document', async () => {
    const rows = await db.$queryRaw<Array<{ name: string; qual: string }>>`
      SELECT polname AS name, pg_get_expr(polqual, polrelid) AS qual
        FROM pg_policy
       WHERE polrelid = 'public.document'::regclass
       ORDER BY polname
    `;
    expect(rows).toEqual([
      { name: 'document_isolation', qual: '(tenant_id = app.current_tenant_id())' },
      {
        name: 'document_mandate_artifact_scope',
        qual:
          '((tenant_id = app.current_tenant_id()) AND ((NOT has_mandate_artifact) OR ' +
          'app.mandate_artifact_document_allowed(tenant_id, (id)::text)))',
      },
      {
        name: 'document_payroll_restriction',
        qual:
          "((NOT requires_payroll_access) OR (app.current_actor_type() = 'SYSTEM'::text) OR " +
          "((app.current_actor_type() = 'STAFF'::text) AND " +
          "app.expansion_staff_permission(tenant_id, app.current_actor_id(), 'PAYROLL_MANAGE'::text)))",
      },
    ]);
  });

  it('findet dieselben Dokumente in derselben Reihenfolge wie die bisherige Abfrage unter RLS', async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const scopes: Array<[string, Scope]> = [
        ['offen', { clientId: f.clients.offen, folderId: null, deleted: false }],
        ['offen gelöscht', { clientId: f.clients.offen, folderId: null, deleted: true }],
        [
          'offen Ordner A',
          { clientId: f.clients.offen, folderId: f.folders.ordnerA, deleted: false },
        ],
        ['vertraulich', { clientId: f.clients.vertraulich, folderId: null, deleted: false }],
        ['intern', { clientId: null, folderId: null, deleted: false }],
        ['intern Ordner', { clientId: null, folderId: f.folders.ordnerIntern, deleted: false }],
      ];
      const begriffe = [
        'rechnung',
        'RECHNUNG 2025',
        'lohnjournal',
        'strukturbild',
        'markiert',
        'geheim',
        'kanzlei',
        'fremd',
        // LIKE-Metazeichen wirken wie im Prisma-`contains` (unverändertes Muster).
        '50%',
        'kunde_1',
        '%',
        'nichts dergleichen',
      ];
      const viewers = [
        { name: 'ADMIN', id: f.adminId, restricted: false },
        { name: 'Mitarbeiter', id: f.employeeId, restricted: true },
        { name: 'Lohn', id: f.payrollId, restricted: true },
      ];
      for (const viewer of viewers) {
        await setActor(tx, f.tenantId, viewer.id, 'STAFF');
        for (const [name, scope] of scopes) {
          for (const begriff of begriffe) {
            // Den vertraulichen Mandanten blendet die Seite für Mitarbeiter
            // schon vorher aus (canAccessClientTx); die Funktion ebenso.
            const erwartet =
              viewer.restricted && scope.clientId === f.clients.vertraulich
                ? []
                : await bisherigeAbfrage(tx, f.tenantId, scope, begriff);
            expect(
              await candidates(tx, scope, begriff),
              `${viewer.name} ${name} ${begriff}`,
            ).toEqual({ ids: erwartet, ueberlauf: false });
          }
        }
      }

      // Stichproben: Lohn-Sperre, Mandatsartefakte, Ordner, Metazeichen.
      const offen = scopes[0]![1];
      await setActor(tx, f.tenantId, f.employeeId, 'STAFF');
      expect((await candidates(tx, offen, 'lohnjournal')).ids).toEqual([]);
      expect((await candidates(tx, offen, 'strukturbild')).ids).toEqual([]);
      expect((await candidates(tx, offen, 'markiert')).ids).toEqual([f.docs.markiert]);
      expect((await candidates(tx, offen, 'kunde_1')).ids).toEqual([
        f.docs.bindestrich,
        f.docs.unterstrich,
      ]);
      await setActor(tx, f.tenantId, f.payrollId, 'STAFF');
      expect((await candidates(tx, offen, 'lohnjournal')).ids).toEqual([f.docs.lohn]);
      await setActor(tx, f.tenantId, f.adminId, 'STAFF');
      expect((await candidates(tx, offen, 'rechnung 2025')).ids).toEqual([
        f.docs.lohn,
        f.docs.januar,
      ]);
      expect((await candidates(tx, scopes[1]![1], 'rechnung')).ids).toEqual([
        f.docs.februarGeloescht,
      ]);
      expect((await candidates(tx, scopes[2]![1], 'rechnung')).ids).toEqual([f.docs.maerz]);
      expect((await candidates(tx, scopes[4]![1], 'rechnung')).ids).toEqual([f.docs.kanzlei]);
    });
  });

  it('liefert nur den Tenant aus dem Kontext und nur aktiven Kanzleipersonen', async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const intern: Scope = { clientId: null, folderId: null, deleted: false };
      const offen: Scope = { clientId: f.clients.offen, folderId: null, deleted: false };

      await setActor(tx, f.tenantId, f.adminId, 'STAFF');
      expect(await candidates(tx, intern, 'rechnung')).toEqual({
        ids: [f.docs.kanzlei],
        ueberlauf: false,
      });
      // Fremder Tenant im Kontext: nur dessen Dokumente; ein fremder Mandant
      // als Parameter liefert nichts.
      await setActor(tx, f.foreignTenantId, f.foreignAdminId, 'STAFF');
      expect(await candidates(tx, intern, 'rechnung')).toEqual({
        ids: [f.docs.fremd],
        ueberlauf: false,
      });
      expect(await candidates(tx, offen, 'rechnung')).toEqual({ ids: [], ueberlauf: false });
      // Akteur eines anderen Tenants im eigenen Kontext, inaktive Person,
      // Portal-Kontakt, SYSTEM, kein Kontext: keine Zeile.
      for (const [tenant, actor, type] of [
        [f.tenantId, f.foreignAdminId, 'STAFF'],
        [f.tenantId, f.inactiveId, 'STAFF'],
        [f.tenantId, f.adminId, 'CLIENT_CONTACT'],
        [f.tenantId, '', 'SYSTEM'],
        ['', '', ''],
      ] as const) {
        await setActor(tx, tenant, actor, type);
        expect(await candidates(tx, intern, 'rechnung'), `${type} ${actor}`).toEqual({
          ids: [],
          ueberlauf: false,
        });
      }
      // Kein Suchbegriff: keine Zeile.
      await setActor(tx, f.tenantId, f.adminId, 'STAFF');
      expect(await candidates(tx, intern, null)).toEqual({ ids: [], ueberlauf: false });
    });
  });

  it('liefert die jüngsten Treffer bis zur Grenze, meldet weitere und nutzt den Trigram-Index', async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const offen: Scope = { clientId: f.clients.offen, folderId: null, deleted: false };
      await setActor(tx, f.tenantId, f.adminId, 'STAFF');
      const alle = await bisherigeAbfrage(tx, f.tenantId, offen, 'r');
      expect(alle.length).toBeGreaterThan(2);
      expect(await candidates(tx, offen, 'r', 2)).toEqual({
        ids: alle.slice(0, 2),
        ueberlauf: true,
      });
      expect(await candidates(tx, offen, 'r', alle.length)).toEqual({
        ids: alle,
        ueberlauf: false,
      });

      // Genug Zeilen der Ebene, dass ein seltener Begriff über den
      // Trigram-Index billiger ist als jeder B-Tree.
      await tx.$executeRaw`
        INSERT INTO public.document (tenant_id, client_id, title, classification, mime_type, updated_at)
        SELECT ${f.tenantId}::uuid, NULL, 'Füllakte ' || g, 'GENERAL', 'application/pdf', now()
          FROM generate_series(1, 5000) AS g
      `;
      const rare = (
        await tx.document.create({
          data: {
            tenantId: f.tenantId,
            clientId: null,
            title: 'Zylinderkopfdichtung Gutachten',
            classification: 'GENERAL',
            mimeType: 'application/pdf',
          },
        })
      ).id;
      await tx.$executeRawUnsafe('ANALYZE public.document');
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const scans = () =>
        tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT pg_stat_get_xact_numscans('public.document_title_trgm_idx'::regclass) AS n
        `.then((rows) => Number(rows[0]?.n ?? 0));
      const intern: Scope = { clientId: null, folderId: null, deleted: false };
      const start = await scans();
      // Bisherige Abfrage der Seite: ILIKE ist nicht LEAKPROOF, unter RLS
      // deshalb kein Indexscan, auch ohne Seqscan.
      expect(await bisherigeAbfrage(tx, f.tenantId, intern, 'zylinderkopf')).toEqual([rare]);
      const nachBisher = await scans();
      expect(nachBisher - start).toBe(0);
      expect(await candidates(tx, intern, 'zylinderkopf')).toEqual({
        ids: [rare],
        ueberlauf: false,
      });
      expect((await scans()) - nachBisher).toBeGreaterThan(0);
    });
  });
});
