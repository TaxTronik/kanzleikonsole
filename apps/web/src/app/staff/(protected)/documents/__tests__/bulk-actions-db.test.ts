// Fachkatalog: DOC-PORTAL-SHARING-001
// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// Fachkatalog: AUDIT-HASH-CHAIN-001
// Review-Finding P-18: Bulk-Actions der Dokumentenverwaltung gegen echtes
// PostgreSQL — App-Rolle mit RLS, Datenbank-Trigger, Audit-Hash-Chain und die
// echte Mandanten-Zugriffsprüfung. Ersetzt werden nur Session, Next-Cache,
// Object Store und die Verbindungsgrenze (zum Zählen der Transaktionen).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';
import type { StaffSession } from '@/server/auth/staff';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const fixture = vi.hoisted(() => ({
  session: null as StaffSession | null,
  inTransaction: false,
  transactions: 0,
  run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> => undefined,
  record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
  revalidate: vi.fn(),
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => fixture.session }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
// Nur Metadaten-Umklassifizierungen: kein Object-Store-Zugriff.
vi.mock('@taxtronik/storage', () => ({
  fetchObjectBytes: vi.fn(),
  deleteObject: vi.fn(),
  deleteObjectVersion: vi.fn(),
  prepareBytesCommitWithTier: vi.fn(),
  commitPreparedBytes: vi.fn(),
  classificationToTier: (classification: string) =>
    classification.startsWith('GOBD_')
      ? 'GOBD'
      : classification === 'GWG_EVIDENCE'
        ? 'GWG'
        : 'NONE',
  gobdRetentionYears: () => 10,
}));
vi.mock('@/server/container', () => ({
  evidenceService: {
    record: (tx: TxClient, event: AuditEventInput) => fixture.record(tx, event),
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => {
    // Cache-Invalidierung erst nach dem Commit, und nur einmal je Bulk-Action.
    expect(fixture.inTransaction).toBe(false);
    fixture.revalidate(...args);
  },
}));

import {
  retagDocumentsAction,
  setDocumentsShareAction,
  softDeleteDocumentsAction,
} from '../actions';
import { moveDocumentItemsAction } from '../folder-actions';

// Der normale Qualitätsjob hat keine Datenbank; der db-Job schaltet die Suite
// ausdrücklich zu. Dann gelten nur lokale PostgreSQL-Ziele.
// B-02: lokal per DOCUMENT_BULK_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env.DOCUMENT_BULK_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'DOCUMENT_BULK_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`DOCUMENT_BULK_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`DOCUMENT_BULK_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

(enabled ? describe : describe.skip)('P-18 Bulk-Actions gegen PostgreSQL', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  const evidence = new EvidenceService(new LocalTimestampAdapter());
  let tenantId: string, staffId: string, openClient: string, secretClient: string;
  let generalType: string, lettersType: string, gwgEvidence: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (await owner.tenant.create({ data: { slug: `p18-${suffix}`, name: 'P-18 Bulk' } }))
      .id;
    // Mitarbeiter ohne Admin-Rolle: die Mandanten-Zugriffsprüfung entscheidet
    // wirklich. PAYROLL_MANAGE macht Lohnarchiv-Dokumente sichtbar.
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `p18-${suffix}@example.test`,
          fullName: 'P-18 Mitarbeiter',
          passwordHash: 'x',
          roles: { create: { role: 'EMPLOYEE' } },
          permissions: { create: { permission: 'PAYROLL_MANAGE' } },
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
      const check = await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId,
        clientId,
        verifiedBy: staffId,
        registerNumber: `HRB-P18-${randomUUID()}`,
      });
      await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
      return { clientId, checkId: check.id };
    };
    const open = await activeClient('P-18 offen', false);
    openClient = open.clientId;
    gwgEvidence = (await owner.gwgIdDocument.findFirstOrThrow({
      where: { gwgCheckId: open.checkId },
      select: { documentId: true },
    }))!.documentId!;
    secretClient = (await activeClient('P-18 vertraulich', true)).clientId;
    generalType = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
    lettersType = (
      await owner.documentType.create({
        data: { tenantId, name: 'Korrespondenz', tier: 'NONE' },
      })
    ).id;

    const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
    fixture.run = async (context, run) => {
      expect(context).toEqual(ctx);
      expect(fixture.inTransaction).toBe(false);
      fixture.transactions++;
      fixture.inTransaction = true;
      try {
        return await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return run(tx);
        });
      } finally {
        fixture.inTransaction = false;
      }
    };
    fixture.record = (tx, event) => evidence.record(tx, event);
  });

  beforeEach(() => {
    fixture.session = {
      user: { tenantId, staffId, roles: ['EMPLOYEE'], permissions: ['PAYROLL_MANAGE'] },
    } as unknown as StaffSession;
    fixture.transactions = 0;
    fixture.revalidate.mockClear();
  });

  afterAll(async () => {
    // Wie die übrigen DB-Suiten: der synthetische Tenant bleibt mit seinen
    // append-only Audit-Zeilen in der Wegwerf-Datenbank; Evidence-Guards bleiben aktiv.
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  async function document(
    title: string,
    data: { clientId?: string | null; deletedAt?: Date; requiresPayrollAccess?: boolean } = {},
  ) {
    const created = await owner.document.create({
      data: {
        tenantId,
        clientId: data.clientId === undefined ? openClient : data.clientId,
        title,
        classification: 'GENERAL',
        documentTypeId: generalType,
        mimeType: 'application/pdf',
        ...(data.deletedAt ? { deletedAt: data.deletedAt, deletedByStaff: staffId } : {}),
        ...(data.requiresPayrollAccess ? { requiresPayrollAccess: true } : {}),
      },
    });
    await owner.documentVersion.create({
      data: {
        documentId: created.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/2026/10/${created.id}.bin`,
        sha256: Buffer.alloc(32, 7),
        sizeBytes: 7n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: staffId,
      },
    });
    return created.id;
  }

  const audits = (resourceIds: string[]) =>
    owner.auditLog.findMany({
      where: { tenantId, resourceId: { in: resourceIds } },
      orderBy: { id: 'asc' },
      select: { action: true, resourceId: true, after: true },
    });

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

  it('blendet eine Auswahl in EINER Transaktion aus, mit Audit und Zugriff je Dokument', async () => {
    const visible = await document('Beleg 1');
    const internal = await document('Kanzleiintern', { clientId: null });
    const secret = await document('Vertraulich', { clientId: secretClient });
    const gone = await document('Schon gelöscht', { deletedAt: new Date() });

    const result = await softDeleteDocumentsAction({
      documentIds: [visible, internal, secret, gone, gwgEvidence],
      reason: 'Dublette',
    });

    expect(result).toEqual({
      ok: false,
      done: 2,
      rejected: expect.arrayContaining([
        { id: secret, error: 'Kein Zugriff auf diesen Mandanten.' },
        { id: gone, error: 'Dokument nicht gefunden oder bereits gelöscht.' },
        { id: gwgEvidence, error: expect.stringContaining('GwG-Prüfung zugeordnet') },
      ]),
    });
    expect(result.rejected).toHaveLength(3);
    expect(fixture.transactions).toBe(1);
    const rows = await owner.document.findMany({
      where: { id: { in: [visible, internal, secret, gwgEvidence] } },
      select: { id: true, deletedAt: true, deleteReason: true },
    });
    expect(rows.find((row) => row.id === visible)?.deleteReason).toBe('Dublette');
    expect(rows.find((row) => row.id === internal)?.deletedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === secret)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === gwgEvidence)?.deletedAt).toBeNull();
    expect(
      (await audits([visible, internal, secret, gone, gwgEvidence])).map((row) => row.action),
    ).toEqual(['document.delete', 'document.delete']);
    expect(fixture.revalidate.mock.calls).toEqual([
      ['/staff/documents'],
      [`/staff/clients/${openClient}`],
    ]);
    await expectIntactChainTail();
  });

  it('isoliert einen Trigger-Fehler (Lohnarchiv) per Einzel-Rückfall; Audit nur für Freigegebenes', async () => {
    const first = await document('Bescheid');
    const payroll = await document('Lohnjournal', { requiresPayrollAccess: true });
    const second = await document('Bescheid 2');

    const result = await setDocumentsShareAction({
      documentIds: [first, payroll, second],
      share: true,
    });

    expect(result.done).toBe(2);
    expect(result.rejected).toEqual([{ id: payroll, error: expect.any(String) }]);
    // Keine Datenbank-Interna in der UI-Meldung.
    expect(result.rejected[0]!.error).not.toMatch(/payroll|archive|P0001/i);
    // Gescheiterter Block (zurückgerollt) + je Dokument eine Transaktion.
    expect(fixture.transactions).toBe(1 + 3);
    const shared = await owner.document.findMany({
      where: { id: { in: [first, payroll, second] }, sharedWithClientAt: { not: null } },
      select: { id: true },
    });
    expect(shared.map((row) => row.id).sort()).toEqual([first, second].sort());
    expect(await audits([first, payroll, second])).toEqual([
      expect.objectContaining({ action: 'document.share' }),
      expect.objectContaining({ action: 'document.share' }),
    ]);
    expect(fixture.revalidate).toHaveBeenCalledTimes(2);
    await expectIntactChainTail();
  });

  /**
   * Wartet, bis eine Verbindung dieser Datenbank auf eine Sperre wartet.
   * S-01: Die Owner-Rolle ist kein Superuser und sieht in pg_stat_activity den
   * Wartezustand fremder Rollen (hier taxtronik_app) nicht; pg_locks und die
   * pid-/datname-Spalten bleiben für jede Rolle sichtbar.
   */
  async function waitForLockWait(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const [row] = await owner.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting
          FROM pg_locks AS waiting_lock
          JOIN pg_stat_activity AS activity ON activity.pid = waiting_lock.pid
         WHERE NOT waiting_lock.granted
           AND activity.datname = current_database()
      `;
      if (row && row.waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Keine Verbindung wartet auf eine Sperre.');
  }

  it('sperrt alle Zeilen vor dem Audit-Lock: eine parallele Einzeländerung führt nicht zum Deadlock', async () => {
    // Einzel-Actions sperren erst ihre Dokumentzeile und nehmen danach mit dem
    // Audit-Event den tenantweiten Audit-Lock. Nähme der Block den Audit-Lock
    // schon beim ersten Dokument und sperrte das zweite erst danach, warteten
    // beide aufeinander.
    const [low, high] = [await document('Parallel A'), await document('Parallel B')].sort();
    let lockedHigh!: () => void;
    const highLocked = new Promise<void>((resolve) => (lockedHigh = resolve));
    let finishSingle!: () => void;
    const singleMayFinish = new Promise<void>((resolve) => (finishSingle = resolve));

    const single = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM document WHERE id = ${high}::uuid FOR UPDATE`;
        lockedHigh();
        await singleMayFinish;
        await evidence.record(tx as unknown as TxClient, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'document.acknowledge',
          resourceType: 'document',
          resourceId: high!,
          after: { acknowledged: true },
        });
      },
      { timeout: 15_000 },
    );
    await highLocked;

    const bulk = setDocumentsShareAction({ documentIds: [low!, high!], share: true });
    await waitForLockWait();
    finishSingle();

    await expect(single).resolves.toBeUndefined();
    await expect(bulk).resolves.toEqual({ ok: true, done: 2, rejected: [] });
    // Kein Deadlock-Abbruch, also auch kein Einzel-Rückfall.
    expect(fixture.transactions).toBe(1);
    await expectIntactChainTail();
  });

  it('verschiebt Dokumente und Ordner in einer Transaktion; Bereichsgrenzen bleiben je Eintrag', async () => {
    const target = await owner.documentFolder.create({
      data: { tenantId, clientId: openClient, name: `Ziel ${randomUUID()}` },
    });
    const folder = await owner.documentFolder.create({
      data: { tenantId, clientId: openClient, name: `Unterordner ${randomUUID()}` },
    });
    const moved = await document('Zu verschieben');
    const internal = await document('Kanzleiintern', { clientId: null });

    const result = await moveDocumentItemsAction({
      documentIds: [moved, internal],
      folderIds: [folder.id],
      targetFolderId: target.id,
    });

    expect(result).toEqual({
      ok: false,
      done: 2,
      rejected: [{ id: internal, error: 'Ordner gehört zu einem anderen Mandanten/Bereich.' }],
    });
    expect(fixture.transactions).toBe(1);
    expect(
      (await owner.document.findUnique({ where: { id: moved }, select: { folderId: true } }))
        ?.folderId,
    ).toBe(target.id);
    expect((await owner.documentFolder.findUnique({ where: { id: folder.id } }))?.parentId).toBe(
      target.id,
    );
    expect((await audits([moved, internal, folder.id])).map((row) => row.action).sort()).toEqual([
      'document.move_folder',
      'document_folder.move',
    ]);
  });

  it('ändert den Datei-Typ (gleiche Schutzstufe) für die Auswahl in einer Schreibtransaktion', async () => {
    const one = await document('Brief 1');
    const two = await document('Brief 2');

    const result = await retagDocumentsAction({
      documentIds: [one, two],
      documentTypeId: lettersType,
    });

    expect(result).toEqual({ ok: true, done: 2, rejected: [] });
    // Ziel, Stand der Auswahl, Metadatenänderung der Auswahl.
    expect(fixture.transactions).toBe(3);
    const rows = await owner.document.findMany({
      where: { id: { in: [one, two] } },
      select: { documentTypeId: true },
    });
    expect(rows.map((row) => row.documentTypeId)).toEqual([lettersType, lettersType]);
    expect(await audits([one, two])).toEqual([
      expect.objectContaining({
        action: 'document.retag',
        after: expect.objectContaining({ reStored: false }),
      }),
      expect.objectContaining({
        action: 'document.retag',
        after: expect.objectContaining({ reStored: false }),
      }),
    ]);
    expect(fixture.revalidate.mock.calls).toEqual([
      ['/staff/documents'],
      [`/staff/clients/${openClient}`],
    ]);
    await expectIntactChainTail();
  });
});
