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
//   - Hartes Löschen eines Mandanten scheitert schon an der Bindung allein
//     (Fremdschlüssel; Mandant ohne GwG-Belege, nur mit Superuser herstellbar –
//     ein aktiver Mandant hat sonst immer GwG-Belege, deren Schranke vorher
//     abweist, siehe redteam-dokumente-db.test.ts RT3B-D2).
// Datenbankfehler prüft die gemeinsame Prüfhilfe (testing/db-fehler.ts,
// kk-tcms-qual): SQLSTATE, Meldung und Prisma-Code der Datenbank, nie die
// zusammengesetzte Prisma-Meldung.
// Die Web-Suiten (Owner-/App-Rolle) belegen Aktionen, Retag und Nebenläufigkeit:
// apps/web/src/server/tcms/__tests__/nachweis-bindung-db.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseErrorInfo } from '../database-error';
import { dbAbgewiesen, erwarteDbFehler, type DbErwartung } from '../testing/db-fehler';
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

/**
 * Sperre der Bindung: Die Datenbank weist `aufruf` ab (gemeinsame Prüfhilfe:
 * SQLSTATE 23001, Meldung und Prisma-Code), und die Einordnung
 * (database-error.ts) erkennt sie als TCMS_EVIDENCE_LOCKED.
 */
async function erwarteBindungssperre(
  aufruf: PromiseLike<unknown>,
  erwartung: { meldung: string; prismaCode: 'P2010' | 'P2039' },
  hinweis: string,
) {
  const ausgang = await aufruf.then(
    () => ({ abgewiesen: false, fehler: undefined as unknown }),
    (fehler: unknown) => ({ abgewiesen: true, fehler }),
  );
  expect(ausgang.abgewiesen, `${hinweis}: erwartet: Ablehnung durch die Datenbank`).toBe(true);
  const soll: DbErwartung = {
    sqlState: '23001',
    prismaCode: erwartung.prismaCode,
    meldung: new RegExp(`^${erwartung.meldung}$`),
  };
  erwarteDbFehler(ausgang.fehler, soll, hinweis);
  expect(databaseErrorInfo(ausgang.fehler)?.kind, `${hinweis}: Einordnung`).toBe(
    'TCMS_EVIDENCE_LOCKED',
  );
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
      prismaCode: 'P2010',
      meldung: 'document: als Nachweis im Tax-CMS verknüpft, GwG-Vernichtung gesperrt',
    } as const;
    await erwarteBindungssperre(
      vorgemerkt(
        Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${beleg.id}::uuid)::text AS claim`,
      ),
      erwartet,
      'Claim',
    );
    await erwarteBindungssperre(
      vorgemerkt(Prisma.sql`SELECT app.destroy_gwg_document_versions(${beleg.id}::uuid) AS n`),
      erwartet,
      'DB-Vernichtung',
    );
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
    await erwarteBindungssperre(
      owner.document.update({ where: { id: d.id }, data: { classification: 'GWG_EVIDENCE' } }),
      {
        prismaCode: 'P2039',
        meldung: 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt',
      },
      'Prisma-Query',
    );
    await erwarteBindungssperre(
      owner.$executeRaw`UPDATE document SET requires_payroll_access = TRUE WHERE id = ${d.id}::uuid`,
      {
        prismaCode: 'P2010',
        meldung: 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt',
      },
      'Raw-SQL',
    );
    expect((await owner.document.findUniqueOrThrow({ where: { id: d.id } })).classification).toBe(
      'GENERAL',
    );
  });

  it('kk-tcms-s10nach: der Scope-Trigger sperrt den Mandanten- und Tenantwechsel auch für den Superuser', async () => {
    const d = await dokument('GENERAL');
    const verknuepfung = await binden(d);
    const fremdTenant = (
      await owner.tenant.create({
        data: { slug: `tcms-guards-fremd-${randomUUID()}`, name: 'TCMS Guards fremd' },
      })
    ).id;
    const fremdMandant = (
      await owner.client.create({
        data: { tenantId: fremdTenant, kind: 'JURPERS', name: 'Fremd GmbH', allowActive: false },
      })
    ).id;
    const meldung = 'document: als Nachweis im Tax-CMS verknüpft, Mandantenwechsel gesperrt';
    for (const data of [
      { clientId: null },
      { tenantId: fremdTenant, clientId: null },
      { tenantId: fremdTenant, clientId: fremdMandant },
    ]) {
      await erwarteBindungssperre(
        owner.document.update({ where: { id: d.id }, data }),
        { prismaCode: 'P2039', meldung },
        `Prisma-Query ${JSON.stringify(data)}`,
      );
    }
    await erwarteBindungssperre(
      owner.$executeRaw`UPDATE document SET client_id = NULL WHERE id = ${d.id}::uuid`,
      { prismaCode: 'P2010', meldung },
      'Raw-SQL',
    );
    // Nur tenant_id: Die Paarprüfung (00_tenant_client_pair_integrity) weist
    // das schon ab; ohne sie (zurückgerollte Superuser-Transaktion) hält der
    // Scope-Trigger allein.
    class Rueckrollen extends Error {}
    await erwarteBindungssperre(
      owner
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE public.document DISABLE TRIGGER "00_tenant_client_pair_integrity"',
          );
          await tx.$executeRaw`UPDATE document SET tenant_id = ${fremdTenant}::uuid WHERE id = ${d.id}::uuid`;
          throw new Rueckrollen();
        })
        .catch((fehler: unknown) => {
          if (fehler instanceof Rueckrollen) return 'zurückgerollt ohne Ablehnung';
          throw fehler;
        }),
      { prismaCode: 'P2010', meldung },
      'nur tenant_id, ohne Paarprüfung',
    );
    expect(await owner.document.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      tenantId,
      clientId,
    });
    // Nach der Freigabe greift die Sperre nicht mehr (Gegenprobe).
    await imTenant((tx) =>
      tx.tcmsDocumentReference.update({
        where: { id: verknuepfung },
        data: { releasedAt: new Date(), releasedBy: staffId, releaseReason: 'REMOVED' },
      }),
    );
    await owner.document.update({ where: { id: d.id }, data: { clientId: null } });
  });

  it('hartes Löschen eines Mandanten scheitert an der Bindung allein (Fremdschlüssel, ohne GwG-Belege)', async () => {
    // Aktiver Mandant ohne GwG-Prüfung und -Belege, gebundenes Dokument mit
    // Version: nur im Replikationsmodus des Superusers herstellbar.
    const mandant = randomUUID();
    const dok = randomUUID();
    const version = randomUUID();
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`
        INSERT INTO client (id, tenant_id, kind, name, allow_active, updated_at)
        VALUES (${mandant}::uuid, ${tenantId}::uuid, 'JURPERS', 'Ohne GwG GmbH', TRUE, now())`;
      await tx.$executeRaw`
        INSERT INTO document (id, tenant_id, client_id, title, classification, mime_type, updated_at)
        VALUES (${dok}::uuid, ${tenantId}::uuid, ${mandant}::uuid, 'Kreditorenliste', 'GENERAL',
                'application/pdf', now())`;
      await tx.$executeRaw`
        INSERT INTO document_version
          (id, document_id, version_no, storage_bucket, storage_key, sha256, size_bytes,
           scan_status, created_by_id)
        VALUES (${version}::uuid, ${dok}::uuid, 1, 'general', ${`tenants/${tenantId}/${dok}.pdf`},
                ${Buffer.alloc(32, 0x4b)}, 812, 'CLEAN', ${staffId}::uuid)`;
      await tx.$executeRaw`
        INSERT INTO tcms_document_reference
          (tenant_id, client_id, document_id, document_version_id, sha256,
           tcms_subject, tcms_execution_id, created_by)
        VALUES (${tenantId}::uuid, ${mandant}::uuid, ${dok}::uuid, ${version}::uuid,
                ${Buffer.alloc(32, 0x4b)}, 'EXECUTION', 'cmvfohnegwg', ${staffId}::uuid)`;
    });
    // kk-tcms-s10nach: Das Löschen setzt document.client_id per ON DELETE SET
    // NULL; dieses Update weist zuerst der Scope-Trigger ab (Mandantenwechsel
    // eines gebundenen Dokuments).
    await erwarteBindungssperre(
      owner.$executeRaw`DELETE FROM client WHERE id = ${mandant}::uuid`,
      {
        prismaCode: 'P2010',
        meldung: 'document: als Nachweis im Tax-CMS verknüpft, Mandantenwechsel gesperrt',
      },
      'Mandant',
    );
    // Ohne den Scope-Trigger hält der Fremdschlüssel der Verknüpfung allein
    // (Superuser-Transaktion, zurückgerollt).
    class Rueckrollen extends Error {}
    await dbAbgewiesen(
      owner
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE public.document DISABLE TRIGGER document_tcms_reference_scope_guard',
          );
          await tx.$executeRaw`DELETE FROM client WHERE id = ${mandant}::uuid`;
          throw new Rueckrollen();
        })
        .catch((fehler: unknown) => {
          if (fehler instanceof Rueckrollen) return 'zurückgerollt ohne Ablehnung';
          throw fehler;
        }),
      { sqlState: '23503', constraint: 'tcms_document_reference_client_id_fkey' },
      'Mandant ohne Scope-Trigger',
    );
    expect(await owner.client.count({ where: { id: mandant } })).toBe(1);
    expect(await owner.document.count({ where: { id: dok, clientId: mandant } })).toBe(1);
  });
});
