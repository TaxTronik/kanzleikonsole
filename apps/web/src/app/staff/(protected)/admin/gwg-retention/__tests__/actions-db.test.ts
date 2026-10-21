// =============================================================================
// GwG-Pflichtvernichtung gegen PostgreSQL (RT3B-K-01, RT3B-K-02): die echte
// Aktion confirmGwgDeletionAction mit App-Rolle, RLS, Triggern, dem DB-Claim
// app.assert_gwg_document_destruction_due und app.destroy_gwg_document_versions.
// Ersetzt sind nur die Request-Authentisierung (staffAuth), next/cache, das Log
// und der Object Store (deleteObjectVersion protokolliert jeden Aufruf und hält
// den Datenbankstand fest, den ein Beobachter in diesem Moment sieht).
//
// Belegt:
//   - K-02: Der Claim liefert `void`; die Aktion liest ihn als Text und
//     vernichtet einen fälligen Beleg vollständig (der Unit-Test mockt
//     $queryRaw und sah den Deserialisierungsfehler von Prisma 7 nicht).
//   - Reihenfolge Claim → Commit → Bytes → DB-Abschluss: Beim ersten
//     Object-Store-Löschen ist die Vormerkung samt Audit committet, das
//     Dokument noch nicht vernichtet und keine Verknüpfung offen.
//   - K-01: Ein im Tax-CMS verknüpftes Dokument (Nachweis oder Anlage einer
//     Ereignismeldung) wird mit festem Grund abgewiesen – ohne Vormerkung,
//     Audit und Object-Store-Aufruf; die Verknüpfung bleibt offen.
//   - kk-tcms-s11 (Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg,
//     der als Nachweis gebunden war, gilt zugleich als steuerliche Unterlage.
//     Nach der Freigabe der Bindung weist die Aktion ihn bis zum Ablauf der
//     GoBD-Frist der Steuerunterlage ab (fester Text, ohne Vormerkung, Audit
//     und Bytes); nach Ablauf beider Fristen vernichtet sie ihn vollständig,
//     samt der freigegebenen Verweise (deren Fremdschlüssel ließ den
//     DB-Abschluss vorher nach dem Löschen der Bytes scheitern). Der Stichtag
//     der Datenbank ist derselbe wie retentionUntilForYears(10, Anlage).
//
// Die Aktion übersetzt eine Ablehnung des Claims in einen festen Text. Welchen
// Datenbankfehler sie dabei übersetzt hat, hält der Spion an der Einordnung
// (`isDatabaseError`) fest; geprüft wird er mit der gemeinsamen Prüfhilfe
// (SQLSTATE und Meldung der Datenbank, kk-tcms-qual). Sonst bliebe der Test
// auch grün, wenn der Claim aus einem anderen Grund scheitert (vor K-02 etwa
// am Lesen von void).
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     'src/app/staff/(protected)/admin/gwg-retention/__tests__/actions-db.test.ts'
// Fachkatalog: GWG-RETENTION-DESTRUCTION-001, TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TxClient } from '@taxtronik/db';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../../../../packages/db/src/__tests__/gwg-test-fixture';

interface Beobachtung {
  key: string;
  vorgemerkt: boolean;
  vernichtet: boolean;
  versionen: number;
  auditVormerkung: number;
  offeneVerknuepfungen: number;
}

const m = vi.hoisted(() => ({
  staff: null as unknown,
  geloescht: [] as string[],
  beobachtet: [] as unknown[],
  beobachten: null as null | ((key: string) => Promise<unknown>),
  /** Fehler, die die Aktion über `isDatabaseError` eingeordnet hat. */
  eingeordnet: [] as unknown[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => m.staff }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/actions/database-error', async (original) => {
  const echt = await original<typeof import('@/server/actions/database-error')>();
  return {
    ...echt,
    isDatabaseError: (...args: Parameters<typeof echt.isDatabaseError>) => {
      m.eingeordnet.push(args[0]);
      return echt.isDatabaseError(...args);
    },
  };
});
vi.mock('@taxtronik/storage', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  deleteObjectVersion: vi.fn(async (_bucket: string, key: string) => {
    if (m.beobachten) m.beobachtet.push(await m.beobachten(key));
    m.geloescht.push(key);
  }),
}));

import {
  meldungsAnlageVerknuepfenTx,
  nachweisVerknuepfenTx,
} from '@/server/tcms/durchfuehrung/verweis';
import {
  TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
  tcmsNachweisSteuerfristText,
} from '@/server/tcms/durchfuehrung/sperre';
import { gobdRetentionYears, retentionUntilForYears } from '@taxtronik/storage';
import { confirmGwgDeletionAction } from '../actions';
import { erwarteDbFehler } from '@taxtronik/db/testing/db-fehler';

const enabled = process.env.GWG_RETENTION_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'GWG_RETENTION_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const DURCHF = 'cmvfgwgfix30000000001';

(enabled ? describe : describe.skip)('GwG-Pflichtvernichtung gegen PostgreSQL', () => {
  let owner!: PrismaClient;
  let app!: PrismaClient;
  let tenantId = '';
  let admin = '';
  /** Mandat seit 2019 beendet: Frist eines GwG-Belegs abgelaufen. */
  let altMandant = '';
  /** Laufendes Mandat: Frist beginnt erst mit dem Ende. */
  let laufenderMandant = '';
  let typAllgemein = '';
  let typGwg = '';

  function imTenant<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${admin},true), set_config('app.current_actor_type','STAFF',true)`;
      return fn(tx as unknown as TxClient);
    }) as Promise<T>;
  }

  async function aktiverMandant(name: string) {
    const clientId = (
      await owner.client.create({ data: { tenantId, kind: 'JURPERS', name, allowActive: false } })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId,
      verifiedBy: admin,
      registerNumber: `HRB-GWGFIX3-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    return clientId;
  }

  /** GwG-Beleg (2019, Object-Lock abgelaufen) mit zwei geschützten Versionen. */
  async function gwgBeleg(clientId: string) {
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId,
        title: 'Ausweiskopie Geschäftsführung',
        classification: 'GWG_EVIDENCE',
        documentTypeId: typGwg,
        mimeType: 'application/pdf',
        retentionUntil: new Date('2025-01-01T00:00:00Z'),
        createdAt: new Date('2019-01-15T00:00:00Z'),
      },
    });
    const keys: string[] = [];
    for (const versionNo of [1, 2]) {
      const key = `tenants/${tenantId}/gwg/${doc.id}-${versionNo}.pdf`;
      await owner.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo,
          storageBucket: 'gwg',
          storageKey: key,
          storageVersionId: `v${versionNo}`,
          sha256: Buffer.alloc(32, versionNo),
          sizeBytes: 100n,
          immutable: true,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: admin,
        },
      });
      keys.push(key);
    }
    return { id: doc.id, keys };
  }

  /** Gescanntes allgemeines Dokument (als Nachweis verknüpfbar). */
  async function allgemein(clientId: string, createdAt = new Date('2019-01-15T00:00:00Z')) {
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId,
        title: 'Kontoabstimmung',
        classification: 'GENERAL',
        documentTypeId: typAllgemein,
        mimeType: 'application/pdf',
        retentionUntil: new Date('2025-01-01T00:00:00Z'),
        createdAt,
      },
    });
    await owner.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/${doc.id}.pdf`,
        storageVersionId: 'v1',
        sha256: Buffer.alloc(32, 7),
        sizeBytes: 100n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: admin,
      },
    });
    return doc.id;
  }

  function audits(documentId: string, action: string) {
    return owner.auditLog.count({
      where: { tenantId, resourceType: 'document', resourceId: documentId, action },
    });
  }

  function offen(documentId: string) {
    return owner.tcmsDocumentReference.count({ where: { documentId, releasedAt: null } });
  }

  beforeAll(async () => {
    ({ prismaOwner: owner, prisma: app } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({
        data: { slug: `gwg-fix3-${randomUUID()}`, name: 'GwG-Vernichtung fix3' },
      })
    ).id;
    admin = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `gwg-fix3-${randomUUID()}@example.test`,
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
    altMandant = await aktiverMandant('Altmandant GmbH');
    await owner.client.update({
      where: { id: altMandant },
      data: { mandateEndedAt: new Date('2019-06-30T00:00:00Z') },
    });
    laufenderMandant = await aktiverMandant('Laufend GmbH');
    typAllgemein = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
    typGwg = (
      await owner.documentType.create({
        data: {
          tenantId,
          name: 'GwG-Beleg',
          tier: 'GWG',
          retentionYears: 5,
          classificationKey: 'GWG_EVIDENCE',
        },
      })
    ).id;
  });

  beforeEach(() => {
    m.geloescht.length = 0;
    m.beobachtet.length = 0;
    m.beobachten = null;
    m.eingeordnet.length = 0;
  });

  afterAll(async () => {
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  });

  it('RT3B-K-02: vernichtet einen fälligen GwG-Beleg in der Reihenfolge Claim → Commit → Bytes → DB-Abschluss', async () => {
    const beleg = await gwgBeleg(altMandant);
    m.beobachten = async (key): Promise<Beobachtung> => {
      const d = await owner.document.findUniqueOrThrow({ where: { id: beleg.id } });
      return {
        key,
        vorgemerkt: d.gwgDestructionRequestedAt !== null,
        vernichtet: d.gwgDestroyedAt !== null,
        versionen: await owner.documentVersion.count({ where: { documentId: beleg.id } }),
        auditVormerkung: await audits(beleg.id, 'gwg.evidence.destroy.request'),
        offeneVerknuepfungen: await offen(beleg.id),
      };
    };

    expect(await confirmGwgDeletionAction({ documentId: beleg.id })).toEqual({ ok: true });
    expect(m.eingeordnet, 'keine Ablehnung der Datenbank').toEqual([]);

    // Jede Objektversion genau einmal, jeweils nach dem committeten Claim und vor dem DB-Abschluss.
    expect([...m.geloescht].sort()).toEqual([...beleg.keys].sort());
    for (const b of m.beobachtet as Beobachtung[]) {
      expect(b).toMatchObject({
        vorgemerkt: true,
        vernichtet: false,
        versionen: 2,
        auditVormerkung: 1,
        offeneVerknuepfungen: 0,
      });
    }
    const nachher = await owner.document.findUniqueOrThrow({ where: { id: beleg.id } });
    expect(nachher).toMatchObject({ title: 'VERNICHTET', gwgDestructionError: null });
    expect(nachher.gwgDestroyedAt).not.toBeNull();
    expect(nachher.deletedAt).not.toBeNull();
    expect(await owner.documentVersion.count({ where: { documentId: beleg.id } })).toBe(0);
    expect(await audits(beleg.id, 'gwg.evidence.destroy')).toBe(1);
  });

  it('der DB-Claim weist einen Beleg einer laufenden Geschäftsbeziehung ab: Vormerkung zurückgenommen, keine Bytes', async () => {
    // Die Fristrechnung der Aktion sieht keinen Prüfbezug und hält den Beleg für
    // fällig; erst der Claim kennt die bestehende Geschäftsbeziehung (fehlendes
    // Mandatsende). Vor K-02 scheiterte hier jeder Aufruf schon am Lesen von void.
    const beleg = await gwgBeleg(laufenderMandant);
    const r = await confirmGwgDeletionAction({ documentId: beleg.id });
    expect(r).toEqual({
      ok: false,
      error:
        'Der DB-seitige Vernichtungsclaim ist nicht zulässig; es wurden keine Datei-Bytes gelöscht.',
    });
    // Grund der Ablehnung laut Datenbank: die bestehende Geschäftsbeziehung.
    expect(m.eingeordnet).toHaveLength(1);
    erwarteDbFehler(m.eingeordnet[0], {
      sqlState: '23514',
      meldung:
        'GwG-Beleg gehört zu einer bestehenden oder früher etablierten Geschäftsbeziehung; Mandatsende fehlt.',
    });
    expect(m.geloescht).toEqual([]);
    expect(await audits(beleg.id, 'gwg.evidence.destroy.request')).toBe(0);
    const d = await owner.document.findUniqueOrThrow({ where: { id: beleg.id } });
    expect(d.gwgDestructionRequestedAt).toBeNull();
    expect(await owner.documentVersion.count({ where: { documentId: beleg.id } })).toBe(2);
  });

  it.each(['Nachweis', 'Meldungsanlage'] as const)(
    'RT3B-K-01: weist ein im Tax-CMS verknüpftes Dokument (%s) mit festem Grund ab – ohne Vormerkung, Audit und Bytes',
    async (art) => {
      const id = await allgemein(altMandant);
      const verknuepfung = await imTenant((tx) =>
        art === 'Nachweis'
          ? nachweisVerknuepfenTx(
              tx,
              { tenantId, mandantId: altMandant, staffId: admin },
              id,
              DURCHF,
            ).then((v) => v.verknuepfungId)
          : meldungsAnlageVerknuepfenTx(
              tx,
              { tenantId, mandantId: altMandant, kontaktId: randomUUID() },
              id,
            ),
      );

      expect(await confirmGwgDeletionAction({ documentId: id })).toEqual({
        ok: false,
        error: TCMS_NACHWEIS_VERNICHTUNGSSPERRE,
      });
      // Abgewiesen von der Vorprüfung der Aktion, nicht erst vom Claim der Datenbank.
      expect(m.eingeordnet, 'keine Ablehnung der Datenbank').toEqual([]);
      expect(m.geloescht).toEqual([]);
      const d = await owner.document.findUniqueOrThrow({ where: { id } });
      expect(d).toMatchObject({
        gwgDestructionRequestedAt: null,
        gwgDestroyedAt: null,
        deletedAt: null,
      });
      expect(await audits(id, 'gwg.evidence.destroy.request')).toBe(0);
      expect(
        (await owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id: verknuepfung } }))
          .releasedAt,
      ).toBeNull();
      expect(await owner.documentVersion.count({ where: { documentId: id } })).toBe(1);
    },
  );

  /**
   * Früherer Nachweis als GwG-Beleg: gebunden über den echten Pfad, nach der
   * Freigabe zum GwG-Beleg umklassifiziert (wie der Altbestand vor RT3B-K-01)
   * und wie durch die Migration 20261021150000 angehoben.
   */
  async function fruehererNachweis(createdAt: Date) {
    const id = await allgemein(altMandant, createdAt);
    const { verknuepfungId } = await imTenant((tx) =>
      nachweisVerknuepfenTx(tx, { tenantId, mandantId: altMandant, staffId: admin }, id, DURCHF),
    );
    await owner.tcmsDocumentReference.update({
      where: { id: verknuepfungId },
      data: { releasedAt: new Date(), releasedBy: admin, releaseReason: 'REMOVED' },
    });
    await owner.document.update({
      where: { id },
      data: { classification: 'GWG_EVIDENCE', documentTypeId: typGwg },
    });
    await owner.$queryRaw`SELECT app.raise_tcms_gwg_evidence_retention(${id}::uuid)::text AS n`;
    return { id, verknuepfungId };
  }

  it('kk-tcms-s11: ein früherer Nachweis wird nach der Freigabe erst nach Ablauf der steuerlichen Frist vernichtet', async () => {
    // Anlage 2019: GwG-Frist (Mandatsende 2019) seit 1.1.2025 abgelaufen, Steuerfrist bis 1.1.2030.
    const { id, verknuepfungId } = await fruehererNachweis(new Date('2019-01-15T00:00:00Z'));
    const steuerfrist = new Date('2030-01-01T00:00:00Z');
    expect((await owner.document.findUniqueOrThrow({ where: { id } })).retentionUntil).toEqual(
      steuerfrist,
    );

    expect(await confirmGwgDeletionAction({ documentId: id })).toEqual({
      ok: false,
      error: tcmsNachweisSteuerfristText(steuerfrist),
    });
    expect(m.eingeordnet, 'Vorprüfung der Aktion, nicht erst der Claim').toEqual([]);
    expect(m.geloescht).toEqual([]);
    expect(await audits(id, 'gwg.evidence.destroy.request')).toBe(0);
    expect(await owner.document.findUniqueOrThrow({ where: { id } })).toMatchObject({
      gwgDestructionRequestedAt: null,
      gwgDestroyedAt: null,
      deletedAt: null,
    });
    expect(await owner.documentVersion.count({ where: { documentId: id } })).toBe(1);
    expect(await owner.tcmsDocumentReference.count({ where: { id: verknuepfungId } })).toBe(1);
  });

  it('kk-tcms-s11: nach Ablauf beider Fristen vernichtet die Aktion den früheren Nachweis vollständig, samt freigegebenem Verweis', async () => {
    // Anlage 2014: Steuerfrist 1.1.2025 und GwG-Frist 1.1.2025 abgelaufen.
    const { id, verknuepfungId } = await fruehererNachweis(new Date('2014-03-01T00:00:00Z'));

    expect(await confirmGwgDeletionAction({ documentId: id })).toEqual({ ok: true });
    expect(m.eingeordnet, 'keine Ablehnung der Datenbank').toEqual([]);
    expect(m.geloescht).toEqual([`tenants/${tenantId}/none/${id}.pdf`]);
    const nachher = await owner.document.findUniqueOrThrow({ where: { id } });
    expect(nachher).toMatchObject({ title: 'VERNICHTET', gwgDestructionError: null });
    expect(nachher.gwgDestroyedAt).not.toBeNull();
    expect(await owner.documentVersion.count({ where: { documentId: id } })).toBe(0);
    expect(await owner.tcmsDocumentReference.count({ where: { id: verknuepfungId } })).toBe(0);
    expect(await audits(id, 'gwg.evidence.destroy')).toBe(1);
  });

  it('kk-tcms-s11: der Stichtag der Datenbank ist der der GoBD-Höherstufung (Steuerunterlage, zehn Jahre)', async () => {
    for (const iso of [
      '2014-03-01T00:00:00Z',
      '2019-01-01T00:00:00Z',
      '2019-12-31T23:59:59.999Z',
      '2026-10-21T12:00:00Z',
    ]) {
      const anlage = new Date(iso);
      const zeilen = await owner.$queryRaw<Array<{ bis: Date }>>`
        SELECT app.tcms_gwg_evidence_tax_retention_until(${anlage}::timestamptz AT TIME ZONE 'UTC') AS bis`;
      expect(zeilen, iso).toEqual([
        { bis: retentionUntilForYears(gobdRetentionYears('GOBD_TAX'), anlage) },
      ]);
    }
    expect(gobdRetentionYears('GOBD_TAX')).toBe(10);
  });
});
