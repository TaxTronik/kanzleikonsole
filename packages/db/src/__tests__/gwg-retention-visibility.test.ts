// =============================================================================
// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Welle 15 (Hinweis aus Welle 14): Die GwG-Löschzählung des Workers
// gwg-expiry-check zählt Datei-Belege mit dem Owner-Client (ohne RLS), die
// Admin-Kachel und die Review-Queue mit der App-Rolle im Kontext des
// Betrachters (RLS). Belegt wird gegen PostgreSQL genau, welche Belege die
// RLS ausblendet: nur Ausgabedokumente von Mandatsartefakten
// (document_mandate_artifact_scope), hier ein Übergabeprotokoll der Klasse
// GWG_EVIDENCE, sobald eine seiner Quellen nicht mehr gültig ist (etwa weil
// ihre Vernichtung angefordert wurde). Das gilt für ADMIN/PARTNER und den
// SYSTEM-Kontext gleichermaßen; für ADMIN/PARTNER blendet
// document_payroll_restriction nichts aus. Alle Fixtures liegen in einer
// zurückgerollten Transaktion.
// =============================================================================

import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient as GeneratedPrismaClient } from '@prisma/client';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Sichtbarkeitsnachweis braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
afterAll(() => db.$disconnect());

type Retention = {
  dueGwgDeletionDocsWhere: (now: Date) => Prisma.DocumentWhereInput;
  findDueGwgDeletionDocs: (tx: TxClient, now: Date) => Promise<Array<{ documentId: string }>>;
  countDueGwgRetentionItems: (
    tx: TxClient,
    now: Date,
  ) => Promise<{ documents: number; checks: number }>;
};

const ROLLBACK = new Error('rollback');
// Mandatsende 15.03.2026: Fristbeginn 31.12.2026, löschreif ab 01.01.2032.
const MANDATE_ENDED = new Date('2026-03-15T00:00:00Z');
const NOW = new Date('2032-01-01T00:00:00Z');

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

async function fixture(tx: TxClient) {
  const seed = `${Date.now()}`;
  const tenantId = (
    await tx.tenant.create({ data: { slug: `w15-gwg-${seed}`, name: 'Welle 15 GwG' } })
  ).id;
  const adminId = (
    await tx.staffUser.create({
      data: {
        tenantId,
        email: `admin-${seed}@example.test`,
        fullName: 'Welle 15 Admin',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  const clientId = (
    await tx.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Welle 15 Muster GmbH', allowActive: false },
    })
  ).id;
  const inTransaction = { $transaction: (fn: (t: TxClient) => unknown) => fn(tx) };
  await createVerifiedLegalEntityGwgFixture(inTransaction as unknown as GeneratedPrismaClient, {
    tenantId,
    clientId,
    verifiedBy: adminId,
    registerNumber: `HRB W15 ${seed}`,
  });
  await tx.client.update({ where: { id: clientId }, data: { allowActive: true } });
  const offboardingId = (
    await tx.mandateOffboarding.create({
      data: {
        tenantId,
        clientId,
        endDate: MANDATE_ENDED,
        sourceHash: 'w15-uebergabe',
        sourceSnapshot: {},
        handoverNote: '',
        retentionNote: '',
        createdBy: adminId,
        recipient: 'Nachfolgekanzlei Muster',
      },
    })
  ).id;

  let fill = 0;
  async function evidence(title: string) {
    const created = await tx.document.create({
      data: {
        tenantId,
        clientId,
        title,
        classification: 'GWG_EVIDENCE',
        mimeType: 'application/pdf',
      },
    });
    fill += 1;
    const sha256 = Buffer.alloc(32, fill);
    const version = await tx.documentVersion.create({
      data: {
        documentId: created.id,
        versionNo: 1,
        storageBucket: 'w15-test',
        storageKey: `w15-test/${created.id}/v1`,
        sha256,
        sizeBytes: 1n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: adminId,
      },
    });
    return { id: created.id, versionId: version.id, hash: sha256.toString('hex') };
  }

  // Übergebener GwG-Beleg und das daraus erzeugte Übergabeprotokoll (Klasse
  // GWG_EVIDENCE wie in archiveOffboarding, wenn ein GwG-Beleg übergeben wird).
  const source = await evidence('Ausweiskopie (übergeben)');
  const protocol = await evidence('Übergabeprotokoll');
  const artifactId = (
    await tx.mandateArtifact.create({
      data: {
        tenantId,
        clientId,
        offboardingId,
        sourceKey: 'w15:protocol',
        sourceHash: 'w15-protocol',
        generatorVersion: 'w15-test/1',
        manifest: {
          snapshot: {
            documents: [
              {
                versionId: source.versionId,
                documentId: source.id,
                sha256: source.hash,
                classification: 'GWG_EVIDENCE',
                requiresPayrollAccess: false,
              },
            ],
          },
        },
        kind: 'OFFBOARDING',
        groupKey: 'PROTOCOL',
        classification: 'GWG_EVIDENCE',
        createdBy: adminId,
      },
    })
  ).id;
  await tx.mandateArtifactSource.create({
    data: { artifactId, documentVersionId: source.versionId, sourceHash: source.hash },
  });
  await tx.$executeRaw`
    UPDATE mandate_artifact
       SET status = 'PENDING',
           document_id = ${protocol.id}::uuid,
           document_version_id = ${protocol.versionId}::uuid,
           output_hash = ${protocol.hash}
     WHERE id = ${artifactId}::uuid
  `;
  await tx.client.update({ where: { id: clientId }, data: { mandateEndedAt: MANDATE_ENDED } });
  return { tenantId, adminId, source: source.id, protocol: protocol.id };
}

describeWithDatabase('Welle 15: GwG-Löschzählung Worker (Owner) vs. Kachel (RLS)', () => {
  it('blendet nur Übergabeprotokolle mit ungültiger Quelle aus, für ADMIN und SYSTEM gleich', async () => {
    const path = new URL('../../../gwg/src/index.ts', import.meta.url).href;
    const retention = (await import(path)) as Retention;

    await inRollback(async (tx) => {
      const f = await fixture(tx);
      const where = { tenantId: f.tenantId, ...retention.dueGwgDeletionDocsWhere(NOW) };

      /** Zählt wie der Worker (Owner, ohne RLS) und wie Kachel/Queue (App-Rolle). */
      async function counts() {
        await tx.$executeRawUnsafe('RESET ROLE');
        const worker = await tx.document.count({ where });
        await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
        await setActor(tx, f.tenantId, f.adminId, 'STAFF');
        const tile = await retention.countDueGwgRetentionItems(tx, NOW);
        const queue = (await retention.findDueGwgDeletionDocs(tx, NOW)).map((d) => d.documentId);
        await setActor(tx, f.tenantId, '', 'SYSTEM');
        const system = await tx.document.count({ where });
        await tx.$executeRawUnsafe('RESET ROLE');
        return { worker, tile: tile.documents, system, queue: queue.sort() };
      }

      // Gültige Quellen: alle Zählungen gleich, beide Belege in der Queue (der
      // dritte ist der Ausweisbeleg der verifizierten Prüfung aus dem Fixture).
      const before = await counts();
      expect(before).toMatchObject({ worker: 3, tile: 3, system: 3 });
      expect(before.queue).toEqual(expect.arrayContaining([f.source, f.protocol]));

      // Vernichtung des übergebenen Belegs angefordert: Das Protokoll verliert
      // seine gültige Quelle (app.mandate_artifact_sources_valid) und ist für
      // ADMIN und SYSTEM unsichtbar, bleibt aber löschreif und in der
      // Worker-Zählung.
      await tx.$executeRaw`
        UPDATE document
           SET gwg_destruction_requested_at = now(),
               gwg_destruction_requested_by = ${f.adminId}::uuid
         WHERE id = ${f.source}::uuid
      `;
      const after = await counts();
      expect(after).toMatchObject({ worker: 3, tile: 2, system: 2 });
      expect(after.queue).toContain(f.source);
      expect(after.queue).not.toContain(f.protocol);
      expect(after.queue).toEqual(before.queue.filter((id) => id !== f.protocol));
    });
  }, 60_000);
});
