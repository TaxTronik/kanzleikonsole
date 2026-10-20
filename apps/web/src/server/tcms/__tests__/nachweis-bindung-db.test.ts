// =============================================================================
// RT3B-K-01: Ein im Tax-CMS gebundenes Dokument (Nachweis einer Durchführung,
// Anlage einer Ereignismeldung) verlässt nie den Rahmen, in dem es verknüpft
// werden durfte, und läuft nie in die GwG-Pflichtvernichtung – gegen echtes
// PostgreSQL über App- und Owner-Rolle (RLS, Trigger, SECURITY-DEFINER-Claim).
//
//   Schicht a: Umklassifizierung der Ablage (documents/retag.ts) mit festem
//              Grund, vor jedem Zugriff auf den Object Store.
//   Schicht b: document_tcms_reference_scope_guard (jede Rolle) und der Claim
//              app.assert_gwg_document_destruction_due (auch über
//              app.destroy_gwg_document_versions).
//   Nebenläufig: Verknüpfen und Umklassifizieren serialisieren sich über die
//              Dokumentzeile – nie beides.
//   Härtung D3: document_version_tcms_reference_guard sperrt neue Versionen
//              gebundener Dokumente für jede Rolle (gleiche Abbildung wie die
//              Löschsperre); Verknüpfen und neue Version serialisieren sich.
// (Schicht c, die Vernichtungsaktion: admin/gwg-retention/__tests__.)
//
// Datenbankfehler werden über SQLSTATE und Meldung der Datenbank geprüft
// (meta.driverAdapterError.cause), nie über die zusammengesetzte Prisma-Meldung
// mit Codeausschnitt.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/nachweis-bindung-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001, DOC-RETENTION-CLASS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TxClient } from '@taxtronik/db';
import { databaseErrorInfo } from '@taxtronik/db/database-error';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const m = vi.hoisted(() => ({ staff: null as unknown, speicher: [] as string[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => m.staff }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@taxtronik/storage', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  deleteObjectVersion: vi.fn(async (_b: string, key: string) => {
    m.speicher.push(`löschen:${key}`);
  }),
  deleteObject: vi.fn(async (_b: string, key: string) => {
    m.speicher.push(`löschen:${key}`);
  }),
  fetchVerifiedObjectBytes: vi.fn(async (quelle: { key: string }) => {
    m.speicher.push(`lesen:${quelle.key}`);
    throw new Error('Object Store im Test nicht vorhanden');
  }),
}));

import {
  meldungsAnlageVerknuepfenTx,
  NachweisDokumentUnzulaessig,
  nachweisVerknuepfenTx,
  nachweisVerknuepfungBestaetigen,
  nachweisVerknuepfungFreigeben,
} from '../durchfuehrung/verweis';
import { TCMS_NACHWEIS_UMKLASSIFIZIERUNGSSPERRE } from '../durchfuehrung/sperre';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const DURCHF = 'cmvfbindungfix30000001';

/** SQLSTATE und Meldung der Datenbank, `null` ohne Datenbankfehler. */
async function abweisung(
  aufruf: Promise<unknown>,
): Promise<{ sqlState: unknown; meldung: unknown; art: unknown } | null> {
  const fehler = await aufruf.then(
    () => null,
    (e: unknown) => e,
  );
  const ursache = (
    fehler as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null
  )?.meta?.driverAdapterError?.cause;
  if (!ursache) return null;
  return {
    sqlState: ursache['originalCode'],
    meldung: ursache['originalMessage'],
    art: databaseErrorInfo(fehler)?.kind,
  };
}

const GESPERRT = (was: RegExp) => ({
  sqlState: '23001',
  meldung: expect.stringMatching(new RegExp(`als Nachweis im Tax-CMS verknüpft, ${was.source}`)),
  art: 'TCMS_EVIDENCE_LOCKED',
});

(enabled ? describe : describe.skip)('Bindung an das Tax-CMS (RT3B-K-01)', () => {
  let owner!: PrismaClient;
  let app!: PrismaClient;
  let tenantId = '';
  let admin = '';
  let mandant = '';
  let typ = '';

  function imTenant<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${admin},true), set_config('app.current_actor_type','STAFF',true)`;
      return fn(tx as unknown as TxClient);
    }) as Promise<T>;
  }

  async function dokument(o: { immutable?: boolean } = {}) {
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId: mandant,
        title: 'Kreditorenliste',
        classification: 'GENERAL',
        documentTypeId: typ,
        mimeType: 'text/csv',
      },
    });
    const v = await owner.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/${doc.id}.csv`,
        storageVersionId: 'v1',
        sha256: Buffer.alloc(32, 0x4b),
        sizeBytes: 812n,
        immutable: o.immutable ?? false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: admin,
      },
    });
    return { id: doc.id, key: v.storageKey };
  }

  /** Daten einer neuen Version an der Versions-Route vorbei (direkter Insert). */
  function neueVersion(documentId: string) {
    return {
      data: {
        documentId,
        versionNo: 2,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/${documentId}-2.csv`,
        sha256: Buffer.alloc(32, 0x99),
        sizeBytes: 812n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: admin,
      },
    };
  }

  async function alsNachweis(o: { immutable?: boolean } = {}) {
    const d = await dokument(o);
    const { verknuepfungId } = await imTenant((tx) =>
      nachweisVerknuepfenTx(tx, { tenantId, mandantId: mandant, staffId: admin }, d.id, DURCHF),
    );
    expect(
      await nachweisVerknuepfungBestaetigen(
        { tenantId, actorId: admin, actorType: 'STAFF' },
        verknuepfungId,
        `nw${randomUUID().slice(0, 8)}`,
      ),
    ).toBe(true);
    return { ...d, verknuepfungId };
  }

  async function alsMeldungsanlage() {
    const d = await dokument();
    const verknuepfungId = await imTenant((tx) =>
      meldungsAnlageVerknuepfenTx(
        tx,
        { tenantId, mandantId: mandant, kontaktId: randomUUID() },
        d.id,
      ),
    );
    return { ...d, verknuepfungId };
  }

  const AUSGESCHLOSSEN = [
    { classification: 'GWG_EVIDENCE' },
    { classification: 'PERSONNEL' },
    { classification: 'STAFF_PRIVATE' },
    { requiresPayrollAccess: true },
  ] as const;

  beforeAll(async () => {
    ({ prismaOwner: owner, prisma: app } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({
        data: { slug: `tcms-bindung-${randomUUID()}`, name: 'TCMS Bindung' },
      })
    ).id;
    admin = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `bindung-${randomUUID()}@example.test`,
          fullName: 'Ada Admin',
          passwordHash: 'synthetic',
          isProfessional: true,
          roles: { create: [{ role: 'ADMIN' }] },
        },
      })
    ).id;
    m.staff = {
      user: {
        id: admin,
        email: 'ada@example.test',
        name: 'Ada',
        fullName: 'Ada Admin',
        tenantId,
        staffId: admin,
        roles: ['ADMIN'],
        permissions: [],
      },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    };
    mandant = (
      await owner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Talwind Outdoor GmbH', allowActive: false },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: mandant,
      verifiedBy: admin,
      registerNumber: `HRB-BINDUNG-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: mandant }, data: { allowActive: true } });
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
  });

  beforeEach(() => {
    m.speicher.length = 0;
  });

  afterAll(async () => {
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  });

  it.each([
    ['Nachweis', () => alsNachweis()],
    ['Meldungsanlage', () => alsMeldungsanlage()],
  ] as const)(
    'Schicht b: App- und Owner-Rolle bringen ein gebundenes Dokument (%s) nicht in einen ausgeschlossenen Rahmen',
    async (_art, binden) => {
      const d = await binden();
      for (const data of AUSGESCHLOSSEN) {
        const appRolle = imTenant((tx) => tx.document.update({ where: { id: d.id }, data }));
        expect(await abweisung(appRolle), `App-Rolle ${JSON.stringify(data)}`).toEqual(
          GESPERRT(/Umklassifizieren gesperrt/),
        );
        const ownerRolle = owner.document.update({ where: { id: d.id }, data });
        expect(await abweisung(ownerRolle), `Owner-Rolle ${JSON.stringify(data)}`).toEqual(
          GESPERRT(/Umklassifizieren gesperrt/),
        );
      }
      expect(await owner.document.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
        classification: 'GENERAL',
        requiresPayrollAccess: false,
      });
      // Andere Umklassifizierungen bleiben möglich (TCMS-NACHWEIS-001: Höherstufung
      // nach DOC-RETENTION-CLASS-001), ebenso jede andere Änderung.
      await imTenant((tx) =>
        tx.document.update({
          where: { id: d.id },
          data: { classification: 'GOBD_TAX', title: 'Kreditorenliste 2026' },
        }),
      );
    },
  );

  it('Schicht b: nach der Freigabe ist die Einstufung wieder frei; ungebundene Dokumente sind nie betroffen', async () => {
    const d = await alsNachweis();
    await nachweisVerknuepfungFreigeben(
      { tenantId, actorId: admin, actorType: 'STAFF' },
      { verknuepfungId: d.verknuepfungId },
      'REMOVED',
    );
    await imTenant((tx) =>
      tx.document.update({ where: { id: d.id }, data: { classification: 'PERSONNEL' } }),
    );
    const frei = await dokument();
    await owner.document.update({
      where: { id: frei.id },
      data: { classification: 'STAFF_PRIVATE', requiresPayrollAccess: true },
    });
  });

  it('Schicht a: die Umklassifizierung der Ablage nennt den Grund und berührt den Speicher nicht', async () => {
    const { retagDocumentsAction } = await import('@/app/staff/(protected)/documents/actions');
    const nachweis = await alsNachweis();
    const anlage = await alsMeldungsanlage();
    // PERSONNEL/STAFF_PRIVATE: reine Metadaten; GWG_EVIDENCE: Re-Store (Vorprüfung vor dem Lesen).
    for (const classification of ['PERSONNEL', 'STAFF_PRIVATE', 'GWG_EVIDENCE'] as const) {
      const r = await retagDocumentsAction({
        documentIds: [nachweis.id, anlage.id],
        classification,
      });
      expect(r, classification).toMatchObject({ ok: false, done: 0 });
      expect(r.rejected, classification).toHaveLength(2);
      expect(r.rejected, classification).toEqual(
        expect.arrayContaining([
          { id: nachweis.id, error: TCMS_NACHWEIS_UMKLASSIFIZIERUNGSSPERRE },
          { id: anlage.id, error: TCMS_NACHWEIS_UMKLASSIFIZIERUNGSSPERRE },
        ]),
      );
    }
    expect(m.speicher).toEqual([]);
    for (const d of [nachweis, anlage]) {
      expect((await owner.document.findUniqueOrThrow({ where: { id: d.id } })).classification).toBe(
        'GENERAL',
      );
    }
    // Höherstufung einer geschützten Fassung: der Re-Store hängt eine neue Version
    // an und würde den Verweis verändern – ebenso abgewiesen, ohne Speicherzugriff.
    const geschuetzt = await alsNachweis({ immutable: true });
    expect(
      await retagDocumentsAction({ documentIds: [geschuetzt.id], classification: 'GOBD_TAX' }),
    ).toMatchObject({
      ok: false,
      done: 0,
      rejected: [{ id: geschuetzt.id, error: TCMS_NACHWEIS_UMKLASSIFIZIERUNGSSPERRE }],
    });
    expect(m.speicher).toEqual([]);
    // Gegenprobe: ein ungebundenes Dokument wird umklassifiziert.
    const frei = await dokument();
    expect(
      await retagDocumentsAction({ documentIds: [frei.id], classification: 'PERSONNEL' }),
    ).toMatchObject({ ok: true, done: 1, rejected: [] });
  });

  it('Schicht b: der GwG-Claim und die DB-Vernichtung weisen ein gebundenes Dokument ab; Versionen bleiben', async () => {
    const { Prisma } = await import('@taxtronik/db/prisma-client');
    for (const d of [await alsNachweis(), await alsMeldungsanlage()]) {
      const vorgemerkt = (sql: ReturnType<typeof Prisma.sql>) =>
        imTenant(async (tx) => {
          await tx.document.updateMany({
            where: { id: d.id },
            data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: admin },
          });
          return tx.$queryRaw(sql);
        });
      expect(
        await abweisung(
          vorgemerkt(
            Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${d.id}::uuid)::text AS claim`,
          ),
        ),
      ).toEqual(GESPERRT(/GwG-Vernichtung gesperrt/));
      expect(
        await abweisung(
          vorgemerkt(Prisma.sql`SELECT app.destroy_gwg_document_versions(${d.id}::uuid) AS n`),
        ),
      ).toEqual(GESPERRT(/GwG-Vernichtung gesperrt/));
      expect(await owner.documentVersion.count({ where: { documentId: d.id } })).toBe(1);
      expect(
        (await owner.document.findUniqueOrThrow({ where: { id: d.id } })).gwgDestructionRequestedAt,
      ).toBeNull();
    }
  });

  /** Wartet, bis eine Sitzung dieser Datenbank auf eine Sperre wartet (höchstens 5 s). */
  async function aufSperreWarten() {
    const start = Date.now();
    for (;;) {
      const [z] = await owner.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database()`;
      if ((z?.n ?? 0) > 0 || Date.now() - start > 5000) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('nebenläufig: Umklassifizieren zuerst – das Verknüpfen wartet und scheitert', async () => {
    const d = await dokument();
    let freigeben!: () => void;
    const halten = new Promise<void>((r) => (freigeben = r));
    let gesperrt!: () => void;
    const gehalten = new Promise<void>((r) => (gesperrt = r));
    const umklassifizieren = imTenant(async (tx) => {
      await tx.document.update({ where: { id: d.id }, data: { classification: 'GWG_EVIDENCE' } });
      gesperrt();
      await halten;
    });
    await gehalten;
    // Fehler sofort abfangen: Er kann eintreten, bevor dieser Test ihn erwartet.
    const verknuepfen = imTenant((tx) =>
      nachweisVerknuepfenTx(tx, { tenantId, mandantId: mandant, staffId: admin }, d.id, DURCHF),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    await aufSperreWarten();
    freigeben();
    await umklassifizieren;
    expect(await verknuepfen).toBeInstanceOf(NachweisDokumentUnzulaessig);
    expect(await owner.tcmsDocumentReference.count({ where: { documentId: d.id } })).toBe(0);
  });

  it('nebenläufig: Verknüpfen zuerst – das Umklassifizieren wartet und scheitert', async () => {
    const d = await dokument();
    let freigeben!: () => void;
    const halten = new Promise<void>((r) => (freigeben = r));
    let gesperrt!: () => void;
    const gehalten = new Promise<void>((r) => (gesperrt = r));
    const verknuepfen = imTenant(async (tx) => {
      await nachweisVerknuepfenTx(
        tx,
        { tenantId, mandantId: mandant, staffId: admin },
        d.id,
        DURCHF,
      );
      gesperrt();
      await halten;
    });
    await gehalten;
    // abweisung() startet die (sonst erst beim Await ausgeführte) Prisma-Abfrage sofort.
    const umklassifizieren = abweisung(
      owner.document.update({ where: { id: d.id }, data: { classification: 'GWG_EVIDENCE' } }),
    );
    await aufSperreWarten();
    freigeben();
    await verknuepfen;
    expect(await umklassifizieren).toEqual(GESPERRT(/Umklassifizieren gesperrt/));
    expect((await owner.document.findUniqueOrThrow({ where: { id: d.id } })).classification).toBe(
      'GENERAL',
    );
  });
  it.each([
    ['Nachweis', () => alsNachweis()],
    ['Meldungsanlage', () => alsMeldungsanlage()],
  ] as const)(
    'Härtung D3: keine neue Version eines gebundenen Dokuments (%s) – App- und Owner-Rolle; nach der Freigabe möglich',
    async (art, binden) => {
      const d = await binden();
      expect(
        await abweisung(imTenant((tx) => tx.documentVersion.create(neueVersion(d.id)))),
        'App-Rolle',
      ).toEqual(GESPERRT(/neue Version gesperrt/));
      expect(
        await abweisung(owner.documentVersion.create(neueVersion(d.id)).then((v) => v)),
        'Owner-Rolle',
      ).toEqual(GESPERRT(/neue Version gesperrt/));
      expect(await owner.documentVersion.count({ where: { documentId: d.id } })).toBe(1);
      const ctx = { tenantId, actorId: admin, actorType: 'STAFF' as const };
      if (art === 'Nachweis') {
        await nachweisVerknuepfungFreigeben(ctx, { verknuepfungId: d.verknuepfungId }, 'REMOVED');
      } else {
        await owner.tcmsDocumentReference.update({
          where: { id: d.verknuepfungId },
          data: { releasedAt: new Date(), releasedBy: admin, releaseReason: 'NOT_ATTACHED' },
        });
      }
      await imTenant((tx) => tx.documentVersion.create(neueVersion(d.id)));
      expect(await owner.documentVersion.count({ where: { documentId: d.id } })).toBe(2);
    },
  );

  it('Härtung D3, nebenläufig: neue Version zuerst – das Verknüpfen wartet und bindet die neue Fassung', async () => {
    const d = await dokument();
    let freigeben!: () => void;
    const halten = new Promise<void>((r) => (freigeben = r));
    let gesperrt!: () => void;
    const gehalten = new Promise<void>((r) => (gesperrt = r));
    const version = imTenant(async (tx) => {
      await tx.documentVersion.create(neueVersion(d.id));
      gesperrt();
      await halten;
    });
    await gehalten;
    // Das Verknüpfen sperrt die Dokumentzeile geteilt, bevor es den Verweis aus
    // der neuesten Version bildet; es wartet auf die Sperre der neuen Version
    // und verweist danach auf Version 2 – nie auf die überholte Version 1.
    const verknuepfen = imTenant((tx) =>
      nachweisVerknuepfenTx(tx, { tenantId, mandantId: mandant, staffId: admin }, d.id, DURCHF),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    await aufSperreWarten();
    freigeben();
    await version;
    expect(await verknuepfen).toBeNull();
    const neueste = await owner.documentVersion.findFirstOrThrow({
      where: { documentId: d.id },
      orderBy: { versionNo: 'desc' },
    });
    const zeilen = await owner.tcmsDocumentReference.findMany({ where: { documentId: d.id } });
    expect(neueste.versionNo).toBe(2);
    expect(zeilen.map((z) => z.documentVersionId)).toEqual([neueste.id]);
  }, 15_000);

  it('Härtung D3, nebenläufig: Verknüpfen zuerst – die neue Version wartet und scheitert', async () => {
    const d = await dokument();
    let freigeben!: () => void;
    const halten = new Promise<void>((r) => (freigeben = r));
    let gesperrt!: () => void;
    const gehalten = new Promise<void>((r) => (gesperrt = r));
    const verknuepfen = imTenant(async (tx) => {
      await nachweisVerknuepfenTx(
        tx,
        { tenantId, mandantId: mandant, staffId: admin },
        d.id,
        DURCHF,
      );
      gesperrt();
      await halten;
    });
    await gehalten;
    const version = abweisung(owner.documentVersion.create(neueVersion(d.id)).then((v) => v));
    await aufSperreWarten();
    freigeben();
    await verknuepfen;
    expect(await version).toEqual(GESPERRT(/neue Version gesperrt/));
    expect(await owner.documentVersion.count({ where: { documentId: d.id } })).toBe(1);
  });
});
