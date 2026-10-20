// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001
//
// RT3B-K-01 (TCMS Stufe 3): Datenbankseite der Bindung eines Dokuments an
// einen Verweis des Tax-CMS (tcms_document_reference).
//   - Altbestand: Ein vor der Migration 20261020100000 zum GwG-Beleg
//     umklassifiziertes, noch gebundenes Dokument (heute nur mit Superuser im
//     Replikationsmodus herstellbar) weist der GwG-Claim und die DB-Vernichtung
//     ab; die Versionen bleiben.
//   - document_tcms_reference_scope_guard gilt auch für den Superuser.
//   - Die Einordnung (database-error.ts) erkennt die Sperre über SQLSTATE 23001
//     und den Marker der Migration, aus Prisma-Query (P2039) wie aus Raw-SQL
//     (P2010).
// Die Web-Suiten (Owner-/App-Rolle) belegen Aktionen, Retag und Nebenläufigkeit:
// apps/web/src/server/tcms/__tests__/nachweis-bindung-db.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseErrorInfo } from '../database-error';
import type { Prisma as PrismaTypen } from '@prisma/client';
import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('TCMS-Bindungstest braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId: string;
let staffId: string;
let clientId: string;

/** Datenbankfehler eines Aufrufs (SQLSTATE, Meldung der Datenbank, Einordnung). */
async function abweisung(aufruf: Promise<unknown>) {
  const fehler = await aufruf.then(
    () => null,
    (e: unknown) => e,
  );
  if (fehler === null) throw new Error('Erwarteter Datenbankfehler blieb aus.');
  const info = databaseErrorInfo(fehler);
  const ursache = (
    fehler as { meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } } }
  ).meta?.driverAdapterError?.cause;
  return {
    sqlState: info?.sqlState,
    art: info?.kind,
    prismaCode: info?.prismaCode,
    meldung: ursache?.originalMessage,
  };
}

function imTenant<T>(fn: (tx: PrismaTypen.TransactionClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
      set_config('app.current_actor_id', ${staffId}, true),
      set_config('app.current_actor_type', 'STAFF', true)`;
    return fn(tx);
  });
}

/** Dokument mit einer sauberen Version; Klassifikation und Daten frei wählbar. */
async function dokument(classification: 'GENERAL' | 'GWG_EVIDENCE') {
  const doc = await owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
      set_config('app.current_actor_id', ${staffId}, true),
      set_config('app.current_actor_type', 'STAFF', true)`;
    return tx.document.create({
      data: {
        tenantId,
        clientId,
        title: classification === 'GENERAL' ? 'Kreditorenliste' : 'Ausweiskopie',
        classification,
        mimeType: 'application/pdf',
        retentionUntil: new Date('2025-01-01T00:00:00Z'),
        createdAt: new Date('2019-01-15T00:00:00Z'),
      },
    });
  });
  const version = await owner.documentVersion.create({
    data: {
      documentId: doc.id,
      versionNo: 1,
      storageBucket: classification === 'GENERAL' ? 'general' : 'gwg',
      storageKey: `tenants/${tenantId}/${doc.id}.pdf`,
      storageVersionId: 'v1',
      sha256: Buffer.alloc(32, 0x4b),
      sizeBytes: 812n,
      immutable: classification !== 'GENERAL',
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: staffId,
    },
  });
  return { id: doc.id, versionId: version.id };
}

/** Offene Verknüpfung über den Guard (App-Rolle im Tenant). */
async function binden(d: { id: string; versionId: string }) {
  return (
    await imTenant((tx) =>
      tx.tcmsDocumentReference.create({
        data: {
          tenantId,
          clientId,
          documentId: d.id,
          documentVersionId: d.versionId,
          sha256: Buffer.alloc(32, 0x4b),
          tcmsSubject: 'EXECUTION',
          tcmsExecutionId: 'cmvfguardsfix3',
          createdBy: staffId,
        },
      }),
    )
  ).id;
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = randomUUID();
  tenantId = (
    await owner.tenant.create({ data: { slug: `tcms-guards-${seed}`, name: 'TCMS Guards' } })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `tcms-guards-${seed}@example.test`,
        fullName: 'Ada Admin',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Altmandant GmbH', allowActive: false },
    })
  ).id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId,
    clientId,
    verifiedBy: staffId,
    registerNumber: `HRB-GUARDS-${seed}`,
  });
  await owner.client.update({
    where: { id: clientId },
    data: { allowActive: true, mandateEndedAt: new Date('2019-06-30T00:00:00Z') },
  });
});

afterAll(async () => {
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('Bindung an das Tax-CMS in der Datenbank (RT3B-K-01)', () => {
  it('Altbestand: der GwG-Claim und die DB-Vernichtung weisen einen gebundenen, fälligen GwG-Beleg ab', async () => {
    const beleg = await dokument('GWG_EVIDENCE');
    // Zustand vor der Migration nachstellen: Verknüpfung auf einen GwG-Beleg (der
    // Guard der Verknüpfung lässt das heute nicht zu).
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`
        INSERT INTO tcms_document_reference
          (tenant_id, client_id, document_id, document_version_id, sha256,
           tcms_subject, tcms_execution_id, tcms_evidence_id, created_by)
        VALUES (${tenantId}::uuid, ${clientId}::uuid, ${beleg.id}::uuid,
                ${beleg.versionId}::uuid, ${Buffer.alloc(32, 0x4b)},
                'EXECUTION', 'cmvfaltbestand', 'nwaltbestand', ${staffId}::uuid)`;
    });
    const vorgemerkt = (sql: PrismaTypen.Sql) =>
      imTenant(async (tx) => {
        await tx.document.updateMany({
          where: { id: beleg.id },
          data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: staffId },
        });
        return tx.$queryRaw(sql);
      });
    const erwartet = {
      sqlState: '23001',
      art: 'TCMS_EVIDENCE_LOCKED',
      prismaCode: 'P2010',
      meldung: 'document: als Nachweis im Tax-CMS verknüpft, GwG-Vernichtung gesperrt',
    };
    expect(
      await abweisung(
        vorgemerkt(
          Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${beleg.id}::uuid)::text AS claim`,
        ),
      ),
    ).toEqual(erwartet);
    expect(
      await abweisung(
        vorgemerkt(Prisma.sql`SELECT app.destroy_gwg_document_versions(${beleg.id}::uuid) AS n`),
      ),
    ).toEqual(erwartet);
    expect(await owner.documentVersion.count({ where: { documentId: beleg.id } })).toBe(1);
    expect(await owner.document.findUniqueOrThrow({ where: { id: beleg.id } })).toMatchObject({
      gwgDestroyedAt: null,
      deletedAt: null,
      gwgDestructionRequestedAt: null,
    });

    // Gegenprobe: nach der Freigabe läuft derselbe Beleg durch den Claim.
    await owner.tcmsDocumentReference.updateMany({
      where: { documentId: beleg.id },
      data: { releasedAt: new Date(), releasedBy: staffId, releaseReason: 'REMOVED' },
    });
    await vorgemerkt(
      Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${beleg.id}::uuid)::text AS claim`,
    );
  });

  it('der Scope-Trigger gilt auch für den Superuser und wird über SQLSTATE und Marker eingeordnet', async () => {
    const d = await dokument('GENERAL');
    await binden(d);
    expect(
      await abweisung(
        owner.document.update({ where: { id: d.id }, data: { classification: 'GWG_EVIDENCE' } }),
      ),
    ).toEqual({
      sqlState: '23001',
      art: 'TCMS_EVIDENCE_LOCKED',
      prismaCode: 'P2039',
      meldung: 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt',
    });
    expect(
      await abweisung(
        owner.$executeRaw`UPDATE document SET requires_payroll_access = TRUE WHERE id = ${d.id}::uuid`,
      ),
    ).toEqual({
      sqlState: '23001',
      art: 'TCMS_EVIDENCE_LOCKED',
      prismaCode: 'P2010',
      meldung: 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt',
    });
    expect((await owner.document.findUniqueOrThrow({ where: { id: d.id } })).classification).toBe(
      'GENERAL',
    );
  });
});
