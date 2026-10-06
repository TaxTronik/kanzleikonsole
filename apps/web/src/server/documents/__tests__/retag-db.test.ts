// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// Fachkatalog: DOC-RETENTION-CLASS-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Fachkatalog: AUDIT-HASH-CHAIN-001
// Review-Finding K-03: der Retag-Service (server/documents/retag.ts) gegen echtes
// PostgreSQL — App-Rolle mit RLS, Versions-Trigger (Immutability), das
// Upload-Journal samt app.settle_storage_intent, Audit-Hash-Chain und die echte
// Mandanten-Zugriffsprüfung. Ersetzt werden nur Session, Object Store (Fake mit
// fester Speicheridentität) und die Verbindungsgrenze (zum Zählen der
// Transaktionen).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';
import type { CommitDocumentResult, PreparedBytesCommit } from '@taxtronik/storage';
import type { StaffCtx } from '@/server/actions/staff-action';
import type { StaffSession } from '@/server/auth/staff';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

type OwnerClient = InstanceType<typeof PrismaClient>;

const fixture = vi.hoisted(() => {
  const state = {
    owner: null as unknown as OwnerClient,
    inTransaction: false,
    transactions: 0,
    run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> =>
      undefined,
    record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
  };
  return {
    state,
    // Owner-Verbindung des Upload-Journals (storage-intent.ts): echte Zeilen in
    // storage_orphan, erst nach dem Aufbau der Verbindung zugewiesen.
    prismaOwner: {
      $transaction: (operations: Array<Promise<unknown>>) =>
        state.owner.$transaction(operations as never),
      storageOrphan: {
        create: (args: never) => state.owner.storageOrphan.create(args),
        updateMany: (args: never) => state.owner.storageOrphan.updateMany(args),
      },
    },
  };
});

/** Object-Store-Fake: feste Identität je Absicht, Aufrufe zum Nachprüfen. */
const store = vi.hoisted(() => ({
  prepared: [] as Array<Record<string, unknown>>,
  deleted: [] as unknown[][],
  /** Läuft im bedingten PUT, also nach Journal und vor dem Commit. */
  duringPut: null as null | (() => Promise<void>),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: fixture.prismaOwner }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) =>
    fixture.state.run(ctx, run),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) =>
    fixture.state.run(ctx, run),
}));
vi.mock('@taxtronik/storage', async () => {
  const { createHash: hash, randomUUID: uuid } = await import('node:crypto');
  const { classificationToTier } = await import('@taxtronik/storage/tiers');
  const { UploadRejectedError } = await import('@taxtronik/storage/errors');
  const retentionYears: Record<string, number> = {
    GOBD_INVOICE: 8,
    GOBD_CONTRACT: 6,
    GOBD_TAX: 10,
  };
  return {
    UploadRejectedError,
    classificationToTier,
    // Wie packages/storage: Vertrag 6, Rechnung 8, Steuer und unbekannt 10 Jahre.
    gobdRetentionYears: (classification?: string) =>
      (classification && retentionYears[classification]) || 10,
    fetchObjectBytes: async (bucket: string, key: string) =>
      Buffer.from(`%PDF-1.7 Bestand ${bucket}/${key}`),
    prepareBytesCommitWithTier: async (input: {
      fileData: Buffer;
      tier: 'NONE' | 'GWG' | 'GOBD';
      tenantId: string;
      classification?: string;
      retentionYears?: number;
      retentionAnchor?: Date;
    }): Promise<PreparedBytesCommit> => {
      store.prepared.push({ ...input, fileData: undefined });
      const immutable = input.tier !== 'NONE';
      const anchor = input.retentionAnchor ?? new Date();
      return {
        tier: input.tier,
        tenantId: input.tenantId,
        targetBucket: input.tier.toLowerCase(),
        targetKey: `tenants/${input.tenantId}/${input.tier.toLowerCase()}/retag-${uuid()}.bin`,
        sha256: hash('sha256').update(input.fileData).digest(),
        sizeBytes: BigInt(input.fileData.length),
        immutable,
        retentionUntil: immutable
          ? new Date(Date.UTC(anchor.getUTCFullYear() + (input.retentionYears ?? 5) + 1, 0, 1))
          : null,
        detectedMime: 'application/pdf',
      };
    },
    commitPreparedBytes: async ({
      prepared,
    }: {
      fileData: Buffer;
      prepared: PreparedBytesCommit;
    }): Promise<CommitDocumentResult> => {
      await store.duringPut?.();
      return {
        targetBucket: prepared.targetBucket,
        targetKey: prepared.targetKey,
        storageVersionId: `object-version-${uuid()}`,
        sha256: Buffer.from(prepared.sha256),
        sizeBytes: prepared.sizeBytes,
        immutable: prepared.immutable,
        retentionUntil: prepared.retentionUntil,
        detectedMime: prepared.detectedMime,
      };
    },
    deleteObject: async (...args: unknown[]) => void store.deleted.push(['object', ...args]),
    deleteObjectVersion: async (...args: unknown[]) =>
      void store.deleted.push(['version', ...args]),
  };
});
vi.mock('@/server/container', () => ({
  evidenceService: {
    record: (tx: TxClient, event: AuditEventInput) => fixture.state.record(tx, event),
  },
}));

import { retagDocument, retagDocuments } from '../retag';

// Der normale Qualitätsjob hat keine Datenbank; der db-Job schaltet die Suite
// ausdrücklich zu. Dann gelten nur lokale PostgreSQL-Ziele.
const enabled = process.env.DOCUMENT_RETAG_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`DOCUMENT_RETAG_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`DOCUMENT_RETAG_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const NOT_FOUND = 'Dokument oder Version nicht gefunden.';
const VERSION_DRIFT =
  'Neue Dokumentversion während der Umklassifizierung erkannt. Bitte erneut versuchen.';

(enabled ? describe : describe.skip)('K-03 Retag-Service gegen PostgreSQL', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  const evidence = new EvidenceService(new LocalTimestampAdapter());
  let tenantId: string, staffId: string, openClient: string, secretClient: string;
  let generalType: string, lettersType: string, invoiceType: string;
  let contractType: string, taxType: string, customInvoiceType: string;
  let staff: StaffCtx;

  beforeAll(async () => {
    fixture.state.owner = owner;
    const suffix = randomUUID();
    tenantId = (await owner.tenant.create({ data: { slug: `k03-${suffix}`, name: 'K-03 Retag' } }))
      .id;
    // Mitarbeiter ohne Admin-Rolle: die Mandanten-Zugriffsprüfung entscheidet wirklich.
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `k03-${suffix}@example.test`,
          fullName: 'K-03 Mitarbeiter',
          passwordHash: 'x',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      })
    ).id;
    // Dokumente brauchen aktive Mandanten (GwG-Schranke): erst die verifizierte
    // GwG-Prüfung über die fail-closed Fixture, dann allow_active.
    const activeClient = async (name: string, vertraulich: boolean) => {
      const clientId = (
        await owner.client.create({
          data: { tenantId, kind: 'JURPERS', name, vertraulich, allowActive: false },
        })
      ).id;
      await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId,
        clientId,
        verifiedBy: staffId,
        registerNumber: `HRB-K03-${randomUUID()}`,
      });
      await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
      return clientId;
    };
    openClient = await activeClient('K-03 offen', false);
    secretClient = await activeClient('K-03 vertraulich', true);
    const type = async (
      name: string,
      tier: 'NONE' | 'GOBD',
      classificationKey: string | null,
      retentionYears: number | null,
    ) =>
      (
        await owner.documentType.create({
          data: { tenantId, name, tier, classificationKey, retentionYears },
        })
      ).id;
    generalType = await type('Allgemein', 'NONE', 'GENERAL', null);
    lettersType = await type('Korrespondenz', 'NONE', null, null);
    invoiceType = await type('Rechnung', 'GOBD', 'GOBD_INVOICE', 8);
    contractType = await type('Vertrag', 'GOBD', 'GOBD_CONTRACT', 6);
    taxType = await type('Steuerunterlage', 'GOBD', 'GOBD_TAX', 10);
    customInvoiceType = await type('Eingangsrechnung (eigener Typ)', 'GOBD', null, 8);

    const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
    fixture.state.run = async (context, run) => {
      expect(context).toEqual(ctx);
      expect(fixture.state.inTransaction).toBe(false);
      fixture.state.transactions++;
      fixture.state.inTransaction = true;
      try {
        return await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return run(tx);
        });
      } finally {
        fixture.state.inTransaction = false;
      }
    };
    fixture.state.record = (tx, event) => evidence.record(tx, event);
    staff = {
      session: {
        user: { tenantId, staffId, roles: ['EMPLOYEE'], permissions: [] },
      } as unknown as StaffSession,
      ctx,
      tenantId,
      staffId,
    };
  });

  beforeEach(() => {
    fixture.state.transactions = 0;
    store.prepared = [];
    store.deleted = [];
    store.duringPut = null;
  });

  afterAll(async () => {
    // Wie die übrigen DB-Suiten: der synthetische Tenant bleibt mit seinen
    // append-only Audit-Zeilen in der Wegwerf-Datenbank; Evidence-Guards bleiben aktiv.
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  type Seed = {
    clientId?: string | null;
    typeId?: string;
    classification?: 'GENERAL' | 'GOBD_INVOICE' | 'GOBD_CONTRACT' | 'GOBD_TAX';
    immutable?: boolean;
    scanStatus?: 'CLEAN' | 'PENDING';
  };

  /** Dokument mit einer Version; geschützte Versionen tragen eine Objektversion. */
  async function document(title: string, seed: Seed = {}) {
    const immutable = seed.immutable ?? false;
    const pending = seed.scanStatus === 'PENDING';
    const created = await owner.document.create({
      data: {
        tenantId,
        clientId: seed.clientId === undefined ? openClient : seed.clientId,
        title,
        classification: seed.classification ?? 'GENERAL',
        documentTypeId: seed.typeId ?? generalType,
        mimeType: 'application/pdf',
        createdAt: new Date('2026-02-10T09:00:00.000Z'),
      },
    });
    const version = await owner.documentVersion.create({
      data: {
        documentId: created.id,
        versionNo: 1,
        storageBucket: immutable ? 'gobd' : 'general',
        storageKey: `tenants/${tenantId}/seed/${created.id}.bin`,
        storageVersionId: immutable ? `seed-version-${randomUUID()}` : null,
        sha256: createHash('sha256').update(title).digest(),
        sizeBytes: BigInt(title.length),
        immutable,
        scanStatus: pending ? 'PENDING' : 'CLEAN',
        scanCompletedAt: pending ? null : new Date(),
        createdById: staffId,
      },
    });
    return { id: created.id, version };
  }

  const audits = (resourceIds: string[]) =>
    owner.auditLog.findMany({
      where: { tenantId, resourceId: { in: resourceIds }, action: 'document.retag' },
      orderBy: { id: 'asc' },
      select: { resourceId: true, before: true, after: true },
    });

  const versions = (documentId: string) =>
    owner.documentVersion.findMany({ where: { documentId }, orderBy: { versionNo: 'asc' } });

  const journal = (storageKey: string) =>
    owner.storageOrphan.findMany({ where: { tenantId, storageKey } });

  async function expectIntactChainTail() {
    const tail = await owner.auditLog.findMany({
      where: { tenantId },
      orderBy: { id: 'desc' },
      take: 20,
      select: { prevHash: true, thisHash: true },
    });
    for (let index = 0; index < tail.length - 1; index++) {
      expect(
        Buffer.from(tail[index]!.prevHash).equals(Buffer.from(tail[index + 1]!.thisHash)),
      ).toBe(true);
    }
  }

  it('ändert den Datei-Typ gleicher Stufe als reine Metadatenänderung', async () => {
    const doc = await document('Brief');

    const result = await retagDocument(staff, doc.id, { documentTypeId: lettersType });

    expect(result).toEqual({ ok: true, changed: true, clientId: openClient });
    // Laden + Ziel, dann eine Schreibtransaktion; kein Object-Store-Zugriff.
    expect(fixture.state.transactions).toBe(2);
    expect(store.prepared).toEqual([]);
    expect(
      await owner.document.findUnique({
        where: { id: doc.id },
        select: { classification: true, documentTypeId: true, retentionUntil: true },
      }),
    ).toEqual({ classification: 'GENERAL', documentTypeId: lettersType, retentionUntil: null });
    expect(await versions(doc.id)).toEqual([doc.version]);
    expect(await audits([doc.id])).toEqual([
      {
        resourceId: doc.id,
        before: { classification: 'GENERAL', tier: 'NONE' },
        after: { classification: 'GENERAL', tier: 'NONE', reStored: false },
      },
    ]);
    await expectIntactChainTail();
  });

  it('lässt ein Dokument mit dem Ziel-Typ unverändert: kein Write, kein Audit', async () => {
    const doc = await document('Schon allgemein');

    await expect(retagDocument(staff, doc.id, { documentTypeId: generalType })).resolves.toEqual({
      ok: true,
      changed: false,
    });
    expect(fixture.state.transactions).toBe(1);
    expect(await audits([doc.id])).toEqual([]);
  });

  it('lehnt vor jedem Write ab: Herabstufung, offener Upload, fremder Mandant, unbekannt', async () => {
    const gobd = await document('Rechnung', {
      typeId: invoiceType,
      classification: 'GOBD_INVOICE',
      immutable: true,
    });
    const pending = await document('Upload läuft', { scanStatus: 'PENDING' });
    const secret = await document('Vertraulich', { clientId: secretClient });

    await expect(retagDocument(staff, gobd.id, { documentTypeId: generalType })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('Herabstufung nicht möglich'),
    });
    await expect(
      retagDocument(staff, pending.id, { documentTypeId: invoiceType }),
    ).resolves.toEqual({
      ok: false,
      error: 'Dokument-Upload ist noch nicht abgeschlossen. Bitte zuerst den Upload fortsetzen.',
    });
    await expect(retagDocument(staff, secret.id, { documentTypeId: lettersType })).resolves.toEqual(
      {
        ok: false,
        error: 'Kein Zugriff auf diesen Mandanten.',
      },
    );
    await expect(
      retagDocument(staff, randomUUID(), { classification: 'GOBD_TAX' }),
    ).resolves.toEqual({ ok: false, error: NOT_FOUND });

    // Je Aufruf nur die Lesetransaktion; nichts journalisiert oder geschrieben.
    expect(fixture.state.transactions).toBe(4);
    expect(store.prepared).toEqual([]);
    expect(await audits([gobd.id, pending.id, secret.id])).toEqual([]);
    expect(await versions(gobd.id)).toEqual([gobd.version]);
  });

  it('stuft NONE → GoBD journal-first hoch: die Version zeigt auf die geschützte Kopie', async () => {
    const doc = await document('Beleg');

    const result = await retagDocument(staff, doc.id, { documentTypeId: invoiceType });

    expect(result).toEqual({ ok: true, changed: true, clientId: openClient });
    // Laden, Vorprüfung, Commit-Transaktion (das Journal läuft über die Owner-Verbindung).
    expect(fixture.state.transactions).toBe(3);
    expect(store.prepared).toEqual([
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
        retentionAnchor: new Date('2026-02-10T09:00:00.000Z'),
      }),
    ]);
    const [version] = await versions(doc.id);
    expect(version).toMatchObject({
      id: doc.version.id,
      versionNo: 1,
      storageBucket: 'gobd',
      immutable: true,
      scanStatus: 'CLEAN',
    });
    expect(version!.storageKey).toMatch(new RegExp(`^tenants/${tenantId}/gobd/retag-`));
    expect(version!.storageVersionId).toMatch(/^object-version-/);
    const retentionUntil = new Date(Date.UTC(2035, 0, 1));
    expect(
      await owner.document.findUnique({
        where: { id: doc.id },
        select: { classification: true, documentTypeId: true, retentionUntil: true },
      }),
    ).toEqual({ classification: 'GOBD_INVOICE', documentTypeId: invoiceType, retentionUntil });
    // Die Speicherabsicht ist über app.settle_storage_intent abgeschlossen.
    expect(await journal(version!.storageKey)).toEqual([
      expect.objectContaining({
        source: 'staff.document.retag',
        intent: true,
        storageVersionId: version!.storageVersionId,
        resolution: 'REFERENCED',
        cleanedAt: expect.any(Date),
      }),
    ]);
    expect(await audits([doc.id])).toEqual([
      {
        resourceId: doc.id,
        before: { classification: 'GENERAL', tier: 'NONE' },
        after: {
          classification: 'GOBD_INVOICE',
          tier: 'GOBD',
          reStored: true,
          retentionYears: 8,
          storageBucket: 'gobd',
          appendedVersion: false,
        },
      },
    ]);
    // Das alte ungeschützte Objekt wird nach dem Commit entfernt.
    expect(store.deleted).toEqual([['object', 'general', doc.version.storageKey]]);
    await expectIntactChainTail();
  });

  it('hängt bei einer geschützten Version eine neue an (GoBD 6 → 10 Jahre)', async () => {
    const doc = await document('Vertrag', {
      typeId: contractType,
      classification: 'GOBD_CONTRACT',
      immutable: true,
    });

    const result = await retagDocument(staff, doc.id, { documentTypeId: taxType });

    expect(result).toEqual({ ok: true, changed: true, clientId: openClient });
    const [first, second] = await versions(doc.id);
    // DOC-VERSION-IMMUTABILITY-001: die geschützte Version bleibt unverändert.
    expect(first).toEqual(doc.version);
    expect(second).toMatchObject({
      versionNo: 2,
      storageBucket: 'gobd',
      immutable: true,
      scanStatus: 'CLEAN',
      createdById: staffId,
    });
    expect(await journal(second!.storageKey)).toEqual([
      expect.objectContaining({ resolution: 'REFERENCED', intent: true }),
    ]);
    expect(await audits([doc.id])).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({
          classification: 'GOBD_TAX',
          retentionYears: 10,
          appendedVersion: true,
        }),
      }),
    ]);
    expect(store.deleted).toEqual([]);
  });

  it('erkennt eine neue Version nach dem Object-Write: kein Commit, die Absicht bleibt offen', async () => {
    const doc = await document('Paralleler Upload');
    let parallelKey = '';
    store.duringPut = async () => {
      // Ein paralleler Upload legt zwischen Vorprüfung und Commit Version 2 an.
      parallelKey = `tenants/${tenantId}/seed/${doc.id}-v2.bin`;
      await owner.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 2,
          storageBucket: 'general',
          storageKey: parallelKey,
          sha256: createHash('sha256').update('v2').digest(),
          sizeBytes: 2n,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      });
    };

    const result = await retagDocument(staff, doc.id, { documentTypeId: invoiceType });

    expect(result).toEqual({ ok: false, error: VERSION_DRIFT });
    expect(
      await owner.document.findUnique({
        where: { id: doc.id },
        select: { classification: true, documentTypeId: true },
      }),
    ).toEqual({ classification: 'GENERAL', documentTypeId: generalType });
    const stored = await versions(doc.id);
    expect(stored.map((version) => version.storageKey)).toEqual([
      doc.version.storageKey,
      parallelKey,
    ]);
    // Die journalisierte Absicht bleibt mit gebundener Objektversion offen; der
    // Cleanup-Worker räumt das geschützte Objekt nach der Sicherheitsfrist auf.
    const open = await owner.storageOrphan.findMany({
      where: { tenantId, source: 'staff.document.retag', cleanedAt: null },
    });
    expect(open).toEqual([
      expect.objectContaining({
        intent: true,
        resolution: null,
        storageVersionId: expect.stringMatching(/^object-version-/),
        failure: VERSION_DRIFT,
      }),
    ]);
    expect(await audits([doc.id])).toEqual([]);
    expect(store.deleted).toEqual([]);
  });

  it('verarbeitet eine gemischte Auswahl mit denselben Schritten wie die Einzel-Action', async () => {
    const restore = await document('Beleg zur Höherstufung');
    const unchanged = await document('Schon Rechnung', {
      typeId: invoiceType,
      classification: 'GOBD_INVOICE',
      immutable: true,
    });
    const shorter = await document('Steuerbescheid', {
      typeId: taxType,
      classification: 'GOBD_TAX',
      immutable: true,
    });
    const secret = await document('Vertraulich', { clientId: secretClient });
    const metadata = await document('Eingangsrechnung', {
      typeId: customInvoiceType,
      classification: 'GOBD_TAX',
      immutable: true,
      clientId: null,
    });

    const result = await retagDocuments(
      staff,
      [restore.id, unchanged.id, shorter.id, secret.id, metadata.id],
      { documentTypeId: invoiceType },
      { startedAt: Date.now() },
    );

    expect(result).toEqual({
      ok: true,
      // Re-Store, unverändert (Ziel-Typ schon gesetzt), Metadatenänderung.
      done: 3,
      rejected: expect.arrayContaining([
        { id: shorter.id, error: expect.stringContaining('Kürzere Aufbewahrungsfrist') },
        { id: secret.id, error: 'Kein Zugriff auf diesen Mandanten.' },
      ]),
      pending: [],
      // Erst der Metadaten-Block, dann die Re-Stores.
      changedClients: [null, openClient],
    });
    expect(result.ok && result.rejected).toHaveLength(2);
    // Ziel, Stand der Auswahl, Metadaten-Block, Re-Store (Vorprüfung + Commit).
    expect(fixture.state.transactions).toBe(5);
    expect(
      (await audits([restore.id, unchanged.id, shorter.id, secret.id, metadata.id])).map(
        (row) => [row.resourceId, (row.after as { reStored: boolean }).reStored] as const,
      ),
    ).toEqual([
      [metadata.id, false],
      [restore.id, true],
    ]);
    expect(await versions(metadata.id)).toEqual([metadata.version]);
    expect(
      await owner.document.findUnique({
        where: { id: metadata.id },
        select: { classification: true, documentTypeId: true },
      }),
    ).toEqual({ classification: 'GOBD_INVOICE', documentTypeId: invoiceType });
    await expectIntactChainTail();
  });

  it('meldet einen unbekannten Ziel-Typ vor jeder Dokumentverarbeitung', async () => {
    const doc = await document('Beliebig');
    await expect(
      retagDocuments(staff, [doc.id], { documentTypeId: randomUUID() }, { startedAt: Date.now() }),
    ).resolves.toEqual({ ok: false, error: 'Datei-Typ nicht gefunden.' });
    expect(fixture.state.transactions).toBe(1);
  });
});
