// =============================================================================
// Fachkatalog: ACCESS-TENANT-RLS-001
// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: CLIENT-OFFBOARDING-001
//
// P-01: document.has_mandate_artifact (Migration 20261007100400). Die
// RESTRICTIVE-Policy document_mandate_artifact_scope ruft
// app.mandate_artifact_document_allowed() nur noch für markierte Dokumente auf.
// Nachweise gegen PostgreSQL; alle Fixtures liegen in einer zurückgerollten
// Transaktion, weil Strukturversionen unveränderlich und nicht löschbar sind:
//  (1) Lese- und Schreibprüfung gleichen der bisherigen Policy über eine Matrix
//      aus Dokumenten (ohne Artefakt, intern, markiert ohne Artefakt, STRUCTURE-,
//      OFFBOARDING-, Lohn- und quellenungültiges Artefakt, fremder Tenant) und
//      Betrachtern (ADMIN, EMPLOYEE, SYSTEM, fremder Tenant, ohne Tenant); die
//      tatsächliche RLS der App-Rolle liefert genau diese Mengen;
//  (2) die Verknüpfung eines Artefakts durch die App-Rolle markiert das Dokument;
//  (3) das Flag lässt sich auch mit Superuser-Rechten nicht zurücksetzen;
//  (4) ein unmarkiertes Artefaktdokument (Altbestand) fiele im Vergleich auf;
//      die Bestandsmarkierung der Migration erfasst es, ihre Nachprüfung bricht
//      ohne sie ab.
// =============================================================================

import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient as GeneratedPrismaClient } from '@prisma/client';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261007100400_document_mandate_artifact_flag/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const backfillStart = migration.indexOf('UPDATE public."document" d');
const BACKFILL = migration.slice(backfillStart, migration.indexOf(';', backfillStart) + 1);
const postcheckStart = migration.indexOf('DO $$', backfillStart);
const POSTCHECK = migration.slice(postcheckStart, migration.indexOf('$$;', postcheckStart) + 3);

// Bisherige Policy aus 20260831180000 (USING und WITH CHECK identisch).
const PREVIOUS_POLICY = 'app.mandate_artifact_document_allowed(tenant_id, (id)::text)';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('P-01-Nachweis braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

afterAll(async () => {
  await db.$disconnect();
});

const DOCUMENTS = [
  'plain',
  'internal',
  'flaggedWithoutArtifact',
  'structure',
  'offboarding',
  'payroll',
  'invalidSources',
  'foreign',
] as const;
type DocumentKey = (typeof DOCUMENTS)[number];

interface Fixture {
  tenantId: string;
  foreignTenantId: string;
  adminId: string;
  employeeId: string;
  foreignAdminId: string;
  documents: Record<DocumentKey, string>;
}

interface Viewer {
  name: string;
  tenantId: string;
  actorId: string;
  actorType: string;
}

interface PolicyRow {
  id: string;
  isolation: boolean;
  payroll: boolean;
  previous: boolean;
  using: boolean;
  check: boolean;
}

const ROLLBACK = new Error('rollback');

/** Führt alles in einer Transaktion aus und rollt sie danach immer zurück. */
async function inRollback(work: (tx: TxClient) => Promise<void>): Promise<void> {
  try {
    await db.$transaction(
      async (tx) => {
        await work(tx);
        throw ROLLBACK;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (error === ROLLBACK) return;
    throw error;
  }
  throw new Error('Fixture-Transaktion wurde nicht zurückgerollt.');
}

async function setActor(tx: TxClient, tenantId: string, actorId: string, actorType: string) {
  await tx.$queryRaw`
    SELECT
      set_config('app.current_tenant_id', ${tenantId}, true),
      set_config('app.current_actor_id', ${actorId}, true),
      set_config('app.current_actor_type', ${actorType}, true)
  `;
}

async function staff(tx: TxClient, tenantId: string, name: string, role: 'ADMIN' | 'EMPLOYEE') {
  const created = await tx.staffUser.create({
    data: {
      tenantId,
      email: `${name}-${tenantId}@example.test`,
      fullName: `P-01 ${name}`,
      passwordHash: 'synthetic',
      roles: { create: { role } },
    },
  });
  return created.id;
}

async function buildFixture(tx: TxClient): Promise<Fixture> {
  const seed = `${Date.now()}`;
  const tenantId = (await tx.tenant.create({ data: { slug: `p01-${seed}`, name: 'P-01' } })).id;
  const foreignTenantId = (
    await tx.tenant.create({ data: { slug: `p01-fremd-${seed}`, name: 'P-01 fremd' } })
  ).id;
  const adminId = await staff(tx, tenantId, 'admin', 'ADMIN');
  const employeeId = await staff(tx, tenantId, 'employee', 'EMPLOYEE');
  const foreignAdminId = await staff(tx, foreignTenantId, 'fremd', 'ADMIN');

  const clientId = (
    await tx.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'P-01 Muster GmbH', allowActive: false },
    })
  ).id;
  // Mandantendokumente setzen eine bestandene GwG-Schranke voraus. Der
  // Fixture-Helfer öffnet sonst eine eigene Transaktion.
  const inTransaction = { $transaction: (fn: (t: TxClient) => unknown) => fn(tx) };
  await createVerifiedLegalEntityGwgFixture(inTransaction as unknown as GeneratedPrismaClient, {
    tenantId,
    clientId,
    verifiedBy: adminId,
    registerNumber: `HRB P01 ${seed}`,
  });
  await tx.client.update({ where: { id: clientId }, data: { allowActive: true } });

  const structureVersionId = (
    await tx.mandateStructureVersion.create({
      data: { tenantId, clientId, revision: 1, contentHash: 'p01-struktur', createdBy: adminId },
    })
  ).id;
  const offboardingId = (
    await tx.mandateOffboarding.create({
      data: {
        tenantId,
        clientId,
        endDate: new Date('2026-12-31T00:00:00.000Z'),
        sourceHash: 'p01-uebergabe',
        sourceSnapshot: {},
        handoverNote: '',
        retentionNote: '',
        createdBy: adminId,
        recipient: 'Nachfolgekanzlei Muster',
      },
    })
  ).id;

  let fill = 0;
  async function document(
    key: DocumentKey,
    data: {
      tenantId?: string;
      clientId?: string | null;
      classification?: 'GENERAL' | 'STAFF_PRIVATE' | 'PERSONNEL';
      requiresPayrollAccess?: boolean;
      hasMandateArtifact?: boolean;
    } = {},
  ) {
    const created = await tx.document.create({
      data: {
        tenantId: data.tenantId ?? tenantId,
        clientId: data.clientId === undefined ? clientId : data.clientId,
        title: `P-01 ${key}`,
        classification: data.classification ?? 'GENERAL',
        requiresPayrollAccess: data.requiresPayrollAccess ?? false,
        hasMandateArtifact: data.hasMandateArtifact ?? false,
        mimeType: 'application/pdf',
      },
    });
    fill += 1;
    const sha256 = Buffer.alloc(32, fill);
    const version = await tx.documentVersion.create({
      data: {
        documentId: created.id,
        versionNo: 1,
        storageBucket: 'p01-test',
        storageKey: `p01-test/${created.id}/v1`,
        sha256,
        sizeBytes: 1n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: data.tenantId === foreignTenantId ? foreignAdminId : adminId,
      },
    });
    return { id: created.id, versionId: version.id, outputHash: sha256.toString('hex') };
  }

  const plain = await document('plain');
  const internal = await document('internal', { clientId: null });
  const flagged = await document('flaggedWithoutArtifact', { hasMandateArtifact: true });
  const structure = await document('structure');
  const offboarding = await document('offboarding', { classification: 'STAFF_PRIVATE' });
  const payroll = await document('payroll', {
    classification: 'PERSONNEL',
    requiresPayrollAccess: true,
  });
  const invalidSources = await document('invalidSources', { classification: 'STAFF_PRIVATE' });
  const foreign = await document('foreign', { tenantId: foreignTenantId, clientId: null });

  async function artifact(
    key: string,
    data: {
      kind: 'STRUCTURE' | 'OFFBOARDING';
      classification: string;
      requiresPayrollAccess?: boolean;
      manifest?: Prisma.InputJsonObject;
    },
  ) {
    const created = await tx.mandateArtifact.create({
      data: {
        tenantId,
        clientId,
        structureVersionId: data.kind === 'STRUCTURE' ? structureVersionId : null,
        offboardingId: data.kind === 'OFFBOARDING' ? offboardingId : null,
        sourceKey: `p01:${key}`,
        sourceHash: `p01-${key}`,
        generatorVersion: 'p01-test/1',
        manifest: data.manifest ?? { snapshot: { documents: [] } },
        kind: data.kind,
        groupKey: key,
        classification: data.classification,
        requiresPayrollAccess: data.requiresPayrollAccess ?? false,
        createdBy: adminId,
      },
    });
    return created.id;
  }

  async function link(
    artifactId: string,
    target: { id: string; versionId: string; outputHash: string },
  ) {
    await tx.$executeRaw`
      UPDATE mandate_artifact
         SET status = 'PENDING',
             document_id = ${target.id}::uuid,
             document_version_id = ${target.versionId}::uuid,
             output_hash = ${target.outputHash}
       WHERE id = ${artifactId}::uuid
    `;
  }

  // (2) Wie im Generator verknüpft die App-Rolle im Kontext eines ADMIN.
  const structureArtifact = await artifact('structure', {
    kind: 'STRUCTURE',
    classification: 'GENERAL',
  });
  await setActor(tx, tenantId, adminId, 'STAFF');
  await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
  await link(structureArtifact, structure);
  await tx.$executeRawUnsafe('RESET ROLE');

  await link(
    await artifact('offboarding', { kind: 'OFFBOARDING', classification: 'STAFF_PRIVATE' }),
    offboarding,
  );
  await link(
    await artifact('payroll', {
      kind: 'STRUCTURE',
      classification: 'PERSONNEL',
      requiresPayrollAccess: true,
    }),
    payroll,
  );
  // Manifest erwartet eine Quelle, die fehlt: app.mandate_artifact_sources_valid = FALSE.
  await link(
    await artifact('invalid-sources', {
      kind: 'OFFBOARDING',
      classification: 'STAFF_PRIVATE',
      manifest: { snapshot: { documents: [{ versionId: plain.versionId }] } },
    }),
    invalidSources,
  );

  return {
    tenantId,
    foreignTenantId,
    adminId,
    employeeId,
    foreignAdminId,
    documents: {
      plain: plain.id,
      internal: internal.id,
      flaggedWithoutArtifact: flagged.id,
      structure: structure.id,
      offboarding: offboarding.id,
      payroll: payroll.id,
      invalidSources: invalidSources.id,
      foreign: foreign.id,
    },
  };
}

function viewers(fixture: Fixture): Viewer[] {
  return [
    { name: 'ADMIN', tenantId: fixture.tenantId, actorId: fixture.adminId, actorType: 'STAFF' },
    {
      name: 'EMPLOYEE',
      tenantId: fixture.tenantId,
      actorId: fixture.employeeId,
      actorType: 'STAFF',
    },
    { name: 'SYSTEM', tenantId: fixture.tenantId, actorId: '', actorType: 'SYSTEM' },
    {
      name: 'fremder Tenant',
      tenantId: fixture.foreignTenantId,
      actorId: fixture.foreignAdminId,
      actorType: 'STAFF',
    },
    { name: 'ohne Tenant', tenantId: '', actorId: '', actorType: '' },
  ];
}

async function policyExpressions(tx: TxClient) {
  const rows = await tx.$queryRaw<
    Array<{ name: string; qual: string | null; withCheck: string | null }>
  >`
    SELECT polname AS name,
           pg_get_expr(polqual, polrelid) AS qual,
           pg_get_expr(polwithcheck, polrelid) AS "withCheck"
      FROM pg_policy
     WHERE polrelid = 'public.document'::regclass
  `;
  const byName = new Map(rows.map((row) => [row.name, row]));
  return {
    isolation: byName.get('document_isolation')!.qual!,
    payroll: byName.get('document_payroll_restriction')!.qual!,
    artifactUsing: byName.get('document_mandate_artifact_scope')!.qual!,
    artifactCheck: byName.get('document_mandate_artifact_scope')!.withCheck!,
  };
}

/** Wertet bisherige und aktuelle Policy je Dokument aus und vergleicht mit der RLS. */
async function compare(tx: TxClient, fixture: Fixture, viewer: Viewer) {
  const policies = await policyExpressions(tx);
  const ids = Object.values(fixture.documents);
  await setActor(tx, viewer.tenantId, viewer.actorId, viewer.actorType);
  const rows = await tx.$queryRawUnsafe<PolicyRow[]>(
    `SELECT id::text AS id,
            COALESCE((${policies.isolation}), FALSE) AS "isolation",
            COALESCE((${policies.payroll}), FALSE) AS "payroll",
            COALESCE((${PREVIOUS_POLICY}), FALSE) AS "previous",
            COALESCE((${policies.artifactUsing}), FALSE) AS "using",
            COALESCE((${policies.artifactCheck}), FALSE) AS "check"
       FROM document
      WHERE id = ANY($1::uuid[])`,
    ids,
  );
  await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
  const visible = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id::text AS id FROM document WHERE id = ANY($1::uuid[])',
    ids,
  );
  await tx.$executeRawUnsafe('RESET ROLE');
  const keyOf = new Map(Object.entries(fixture.documents).map(([key, id]) => [id, key]));
  const name = (id: string) => keyOf.get(id) ?? id;
  return {
    rows,
    mismatches: rows
      .filter((row) => row.using !== row.previous || row.check !== row.previous)
      .map((row) => name(row.id))
      .sort(),
    expectedVisible: rows
      .filter((row) => row.isolation && row.payroll && row.previous)
      .map((row) => name(row.id))
      .sort(),
    visible: visible.map((row) => name(row.id)).sort(),
  };
}

describeWithDatabase('P-01: document.has_mandate_artifact', () => {
  it('Policy prüft Artefakte nur für markierte Dokumente', async () => {
    await inRollback(async (tx) => {
      const policies = await policyExpressions(tx);
      for (const expression of [policies.artifactUsing, policies.artifactCheck]) {
        expect(expression).toBe(
          '((tenant_id = app.current_tenant_id()) AND ((NOT has_mandate_artifact) OR ' +
            'app.mandate_artifact_document_allowed(tenant_id, (id)::text)))',
        );
      }
    });
  });

  it('(1)+(2) gleiche Sichtbarkeit und Schreibprüfung wie bisher über die Fixture-Matrix', async () => {
    await inRollback(async (tx) => {
      const fixture = await buildFixture(tx);

      const flags = await tx.document.findMany({
        where: { id: { in: Object.values(fixture.documents) } },
        select: { id: true, hasMandateArtifact: true },
      });
      const flagged = Object.entries(fixture.documents)
        .filter(([, id]) => flags.find((row) => row.id === id)?.hasMandateArtifact)
        .map(([key]) => key)
        .sort();
      // (2) Die Verknüpfung durch die App-Rolle hat "structure" markiert.
      expect(flagged).toEqual(
        ['flaggedWithoutArtifact', 'invalidSources', 'offboarding', 'payroll', 'structure'].sort(),
      );

      const expected: Record<string, DocumentKey[]> = {
        ADMIN: [
          'plain',
          'internal',
          'flaggedWithoutArtifact',
          'structure',
          'offboarding',
          'payroll',
        ],
        EMPLOYEE: ['plain', 'internal', 'flaggedWithoutArtifact', 'structure'],
        SYSTEM: [
          'plain',
          'internal',
          'flaggedWithoutArtifact',
          'structure',
          'offboarding',
          'payroll',
        ],
        'fremder Tenant': ['foreign'],
        'ohne Tenant': [],
      };
      for (const viewer of viewers(fixture)) {
        const result = await compare(tx, fixture, viewer);
        expect(result.rows, viewer.name).toHaveLength(DOCUMENTS.length);
        expect(result.mismatches, viewer.name).toEqual([]);
        expect(result.visible, viewer.name).toEqual(result.expectedVisible);
        expect(result.visible, viewer.name).toEqual([...expected[viewer.name]!].sort());
      }
    });
  });

  it('(3) das Flag lässt sich nicht zurücksetzen', async () => {
    await inRollback(async (tx) => {
      const fixture = await buildFixture(tx);
      await tx.$executeRawUnsafe('SAVEPOINT reset');
      await expect(
        tx.$executeRaw`
          UPDATE document SET has_mandate_artifact = FALSE
           WHERE id = ${fixture.documents.structure}::uuid
        `,
      ).rejects.toThrow(/has_mandate_artifact kann nicht zurückgesetzt werden/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reset');
      // Setzen ohne Artefakt bleibt erlaubt und ist für die Sichtbarkeit neutral.
      await tx.$executeRaw`
        UPDATE document SET has_mandate_artifact = TRUE
         WHERE id = ${fixture.documents.plain}::uuid
      `;
    });
  });

  it('(4) Bestandsmarkierung: ein unmarkiertes Artefaktdokument fiele auf und wird markiert', async () => {
    await inRollback(async (tx) => {
      const fixture = await buildFixture(tx);
      const employee = viewers(fixture).find((viewer) => viewer.name === 'EMPLOYEE')!;

      // Altbestand vor der Migration nachstellen: Verknüpfung ohne Markierung.
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`
        UPDATE document SET has_mandate_artifact = FALSE
         WHERE id = ${fixture.documents.offboarding}::uuid
      `;
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');

      // Ohne Markierung sähe EMPLOYEE das OFFBOARDING-Dokument: der Vergleich
      // erkennt genau diese Abweichung.
      const unmarked = await compare(tx, fixture, employee);
      expect(unmarked.mismatches).toEqual(['offboarding']);
      expect(unmarked.visible).toContain('offboarding');

      await tx.$executeRawUnsafe('SAVEPOINT postcheck');
      await expect(tx.$executeRawUnsafe(POSTCHECK)).rejects.toThrow(
        /P-01: 1 Dokument\(e\) mit Mandatsartefakt sind nicht markiert/,
      );
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT postcheck');

      expect(await tx.$executeRawUnsafe(BACKFILL)).toBe(1);
      await tx.$executeRawUnsafe(POSTCHECK);
      const repaired = await compare(tx, fixture, employee);
      expect(repaired.mismatches).toEqual([]);
      expect(repaired.visible).not.toContain('offboarding');
    });
  });
});
