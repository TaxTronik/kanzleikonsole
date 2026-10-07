// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Fachkatalog: DOC-OBJECT-LOCK-001
// Fachkatalog: RISK-ARCHIVE-SNAPSHOT-001
// Review-Finding K-06: Speicherabsichten (storage_orphan.intent) werden vor dem
// Object-Write journalisiert und in der Fachtransaktion atomar abgeschlossen.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { ActorType, TxClient } from '../tenant-context';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20261006130100_storage_upload_intent/migration.sql',
    import.meta.url,
  ),
  'utf8',
).replace(/--.*$/gm, '');

const riskReferenceMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20261007150000_storage_intent_risk_references/migration.sql',
    import.meta.url,
  ),
  'utf8',
).replace(/--.*$/gm, '');

describe('Speicherabsicht: Migration', () => {
  it('ersetzt die Abschlussfunktion fuer Risikoverweise mit unveraenderter Signatur und Bindung', () => {
    expect(riskReferenceMigration).toMatch(
      /CREATE OR REPLACE FUNCTION app\.settle_storage_intent\(\s*p_intent_id UUID,\s*p_storage_bucket TEXT,\s*p_storage_key TEXT,\s*p_storage_version_id TEXT\s*\)/,
    );
    expect(riskReferenceMigration).toMatch(
      /SECURITY DEFINER\s+SET search_path = pg_catalog, public, app, pg_temp/,
    );
    expect(riskReferenceMigration).toMatch(
      /FROM public\.risk_analysis analysis\s+WHERE analysis\.tenant_id = v_tenant_id/,
    );
  });

  it('schliesst Absichten nur ueber eine eng gebundene SECURITY-DEFINER-Funktion ab', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION app\.settle_storage_intent\(/);
    expect(migration).toMatch(
      /SECURITY DEFINER\s+SET search_path = pg_catalog, public, app, pg_temp/,
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.settle_storage_intent(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.settle_storage_intent(UUID, TEXT, TEXT, TEXT) TO taxtronik_app;',
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Speicherabsicht-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId: string;
let otherTenantId: string;
let staffId: string;
let documentId: string;

async function inContext<T>(
  actorType: ActorType,
  work: (tx: TxClient) => Promise<T>,
  tenant: string = tenantId,
): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenant}, true),
        set_config('app.current_actor_id', ${actorType === 'SYSTEM' ? '' : staffId}, true),
        set_config('app.current_actor_type', ${actorType}, true)
    `;
    return work(tx);
  });
}

function storageKey(tenant: string = tenantId): string {
  return `tenants/${tenant}/none/2026/10/${randomUUID()}.bin`;
}

async function journalIntent(input: { key: string; tenant?: string }) {
  return owner.storageOrphan.create({
    data: {
      tenantId: input.tenant ?? tenantId,
      source: 'test.intent',
      intent: true,
      storageBucket: 'general',
      storageKey: input.key,
      storageVersionId: '',
      sha256: new Uint8Array(32),
      sizeBytes: 7n,
      immutable: false,
      retentionUntil: null,
    },
    select: { id: true },
  });
}

async function insertVersion(tx: TxClient, key: string, versionNo: number, version = 'v-1') {
  await tx.documentVersion.create({
    data: {
      documentId,
      versionNo,
      storageBucket: 'general',
      storageKey: key,
      storageVersionId: version,
      sha256: new Uint8Array(32),
      sizeBytes: 7n,
      immutable: false,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: staffId,
    },
  });
}

function settle(tx: TxClient, intentId: string, key: string, version: string | null = 'v-1') {
  return tx.$executeRaw`
    SELECT app.settle_storage_intent(${intentId}::uuid, 'general', ${key}, ${version})
  `;
}

let nextVersionNo = 1;
let otherStaffId: string;

function riskAnalysisData(tenant: string = tenantId, createdById: string = staffId) {
  return {
    tenantId: tenant,
    sourceText: 'Synthetischer Sachverhalt',
    textHash: 'synthetic-hash',
    katalogVersion: 'katalog',
    engineVersion: 'engine',
    createdById,
  };
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantId = (
    await owner.tenant.create({ data: { name: 'Speicherabsicht', slug: `intent-${seed}` } })
  ).id;
  otherTenantId = (
    await owner.tenant.create({ data: { name: 'Fremd', slug: `intent-other-${seed}` } })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `intent-${seed}@example.test`,
        fullName: 'Speicherabsicht',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  otherStaffId = (
    await owner.staffUser.create({
      data: {
        tenantId: otherTenantId,
        email: `intent-other-${seed}@example.test`,
        fullName: 'Fremd',
        passwordHash: 'synthetic',
      },
    })
  ).id;
  documentId = (
    await owner.document.create({
      data: {
        tenantId,
        ownerStaffId: staffId,
        title: 'Speicherabsicht-Dokument',
        classification: 'GENERAL',
        mimeType: 'application/pdf',
      },
    })
  ).id;
});

afterAll(async () => {
  for (const id of [tenantId, otherTenantId]) {
    if (!id) continue;
    await owner.storageOrphan.deleteMany({ where: { tenantId: id } });
    await owner.tenant.delete({ where: { id } });
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('Speicherabsicht: Datenbank', () => {
  it('erlaubt ABSENT nur fuer offene Absichten ohne gebundene Objektversion', async () => {
    const intent = await journalIntent({ key: storageKey() });
    await expect(
      owner.storageOrphan.update({
        where: { id: intent.id },
        data: { storageVersionId: 'v-9', resolution: 'ABSENT', cleanedAt: new Date() },
      }),
    ).rejects.toThrow(/storage_orphan_absent_intent_check/);
    await expect(
      owner.storageOrphan.update({
        where: { id: intent.id },
        data: { resolution: 'ABSENT', cleanedAt: new Date() },
      }),
    ).resolves.toMatchObject({ resolution: 'ABSENT' });

    const orphan = await owner.storageOrphan.create({
      data: {
        tenantId,
        source: 'test.orphan',
        storageBucket: 'general',
        storageKey: storageKey(),
        sha256: new Uint8Array(32),
        sizeBytes: 7n,
        immutable: false,
      },
    });
    await expect(
      owner.storageOrphan.update({
        where: { id: orphan.id },
        data: { resolution: 'ABSENT', cleanedAt: new Date() },
      }),
    ).rejects.toThrow(/storage_orphan_absent_intent_check/);
  });

  it.each(['STAFF', 'CLIENT_CONTACT', 'SYSTEM'] as const)(
    'schliesst eine referenzierte Absicht im %s-Kontext atomar als REFERENCED ab',
    async (actorType) => {
      const key = storageKey();
      const intent = await journalIntent({ key });
      await inContext(actorType, async (tx) => {
        await insertVersion(tx, key, nextVersionNo++);
        await settle(tx, intent.id, key);
      });
      await expect(
        owner.storageOrphan.findUniqueOrThrow({ where: { id: intent.id } }),
      ).resolves.toMatchObject({
        resolution: 'REFERENCED',
        storageVersionId: 'v-1',
        cleanupClaimedAt: null,
        cleanedAt: expect.any(Date),
      });
    },
  );

  it('laesst die Absicht offen, wenn die Fachtransaktion zurueckrollt', async () => {
    const key = storageKey();
    const intent = await journalIntent({ key });
    await expect(
      inContext('STAFF', async (tx) => {
        await insertVersion(tx, key, nextVersionNo++);
        await settle(tx, intent.id, key);
        throw new Error('fachlicher Abbruch nach dem Abschluss');
      }),
    ).rejects.toThrow('fachlicher Abbruch');
    await expect(
      owner.storageOrphan.findUniqueOrThrow({ where: { id: intent.id } }),
    ).resolves.toMatchObject({ resolution: null, cleanedAt: null, storageVersionId: '' });
  });

  it('verweigert den Abschluss ohne Dokumentreferenz, fremd, beansprucht oder abgeschlossen', async () => {
    const unreferencedKey = storageKey();
    const unreferenced = await journalIntent({ key: unreferencedKey });
    await expect(
      inContext('STAFF', (tx) => settle(tx, unreferenced.id, unreferencedKey)),
    ).rejects.toThrow(/STORAGE_INTENT_UNREFERENCED/);

    // Eine Referenz im eigenen Tenant schliesst keine Absicht eines anderen Tenants.
    const foreignKey = storageKey(otherTenantId);
    const foreign = await journalIntent({ key: foreignKey, tenant: otherTenantId });
    await expect(
      inContext('STAFF', async (tx) => {
        await insertVersion(tx, foreignKey, nextVersionNo++);
        await settle(tx, foreign.id, foreignKey);
      }),
    ).rejects.toThrow(/STORAGE_INTENT_NOT_OPEN/);

    const claimedKey = storageKey();
    const claimed = await journalIntent({ key: claimedKey });
    await owner.storageOrphan.update({
      where: { id: claimed.id },
      data: { cleanupClaimedAt: new Date() },
    });
    await expect(
      inContext('STAFF', async (tx) => {
        await insertVersion(tx, claimedKey, nextVersionNo++);
        await settle(tx, claimed.id, claimedKey);
      }),
    ).rejects.toThrow(/STORAGE_INTENT_NOT_OPEN/);

    const closedKey = storageKey();
    const closed = await journalIntent({ key: closedKey });
    await owner.storageOrphan.update({
      where: { id: closed.id },
      data: { resolution: 'ABSENT', cleanedAt: new Date() },
    });
    await expect(
      inContext('STAFF', async (tx) => {
        await insertVersion(tx, closedKey, nextVersionNo++);
        await settle(tx, closed.id, closedKey);
      }),
    ).rejects.toThrow(/STORAGE_INTENT_NOT_OPEN/);

    // Ein nachgelagert journalisierter Orphan ist keine Speicherabsicht.
    const orphanKey = storageKey();
    const orphan = await owner.storageOrphan.create({
      data: {
        tenantId,
        source: 'test.orphan',
        storageBucket: 'general',
        storageKey: orphanKey,
        sha256: new Uint8Array(32),
        sizeBytes: 7n,
        immutable: false,
      },
    });
    await expect(
      inContext('STAFF', async (tx) => {
        await insertVersion(tx, orphanKey, nextVersionNo++);
        await settle(tx, orphan.id, orphanKey);
      }),
    ).rejects.toThrow(/STORAGE_INTENT_NOT_OPEN/);
  });

  // K-06: Risiko-Archiv und Engine-Rohergebnis sind Verweise ohne Objektversion.
  it('schliesst eine Absicht ueber den Rohergebnis-Verweis einer neuen Risikoanalyse ab', async () => {
    const key = storageKey();
    const intent = await journalIntent({ key });
    await inContext('STAFF', async (tx) => {
      await tx.riskAnalysis.create({
        data: {
          ...riskAnalysisData(),
          rawResultBucket: 'general',
          rawResultKey: key,
        },
      });
      await settle(tx, intent.id, key);
    });
    await expect(
      owner.storageOrphan.findUniqueOrThrow({ where: { id: intent.id } }),
    ).resolves.toMatchObject({ resolution: 'REFERENCED', storageVersionId: 'v-1' });
  });

  it('schliesst eine Absicht ueber den Archivverweis einer Risikoanalyse ab', async () => {
    const key = storageKey();
    const intent = await journalIntent({ key });
    const analysis = await owner.riskAnalysis.create({ data: riskAnalysisData() });
    await inContext('STAFF', async (tx) => {
      await tx.riskAnalysis.update({
        where: { id: analysis.id },
        data: { archivedAt: new Date(), archiveBucket: 'general', archiveKey: key },
      });
      await settle(tx, intent.id, key);
    });
    await expect(
      owner.storageOrphan.findUniqueOrThrow({ where: { id: intent.id } }),
    ).resolves.toMatchObject({ resolution: 'REFERENCED' });
  });

  it('wertet den Verweis einer Risikoanalyse eines anderen Tenants nicht als Bezug', async () => {
    const key = storageKey();
    const intent = await journalIntent({ key });
    await owner.riskAnalysis.create({
      data: {
        ...riskAnalysisData(otherTenantId, otherStaffId),
        rawResultBucket: 'general',
        rawResultKey: key,
      },
    });
    await expect(inContext('STAFF', (tx) => settle(tx, intent.id, key))).rejects.toThrow(
      /STORAGE_INTENT_UNREFERENCED/,
    );
    await expect(
      owner.storageOrphan.findUniqueOrThrow({ where: { id: intent.id } }),
    ).resolves.toMatchObject({ resolution: null, cleanedAt: null });
  });

  it('verlangt einen Mandantenkontext', async () => {
    const key = storageKey();
    const intent = await journalIntent({ key });
    await expect(app.$transaction((tx) => settle(tx, intent.id, key))).rejects.toThrow(
      /STORAGE_INTENT_CONTEXT/,
    );
  });

  it('haelt einen parallelen Worker-Claim bis zum Fachcommit auf und laesst ihn danach leer laufen', async () => {
    const key = storageKey();
    const intent = await journalIntent({ key });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let settled!: () => void;
    const settledSignal = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const domain = inContext('STAFF', async (tx) => {
      await insertVersion(tx, key, nextVersionNo++);
      await settle(tx, intent.id, key);
      settled();
      await commitGate;
    });
    await settledSignal;

    // Gleiche Bedingung wie der Claim des Cleanup-Workers: nur offene Zeilen.
    let claimDone = false;
    const claim = owner.storageOrphan
      .updateMany({
        where: { id: intent.id, cleanedAt: null, cleanupClaimedAt: null },
        data: { cleanupClaimedAt: new Date() },
      })
      .finally(() => {
        claimDone = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(claimDone).toBe(false);

    releaseCommit();
    await domain;
    await expect(claim).resolves.toEqual({ count: 0 });
    await expect(
      owner.storageOrphan.findUniqueOrThrow({ where: { id: intent.id } }),
    ).resolves.toMatchObject({ resolution: 'REFERENCED', cleanupClaimedAt: null });
  });
});
