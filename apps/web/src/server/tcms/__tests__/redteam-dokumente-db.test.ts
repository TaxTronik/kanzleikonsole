// =============================================================================
// Red Team kk-tcms-redteam3b: jede Mutation an Dokumenten gegen ein als
// Nachweis (Durchführung, bestätigt) bzw. als Anlage einer Ereignismeldung
// gebundenes Dokument – ausgeführt über die ECHTEN Server-Aktionen der
// Dokumentablage und der GwG-Vernichtung gegen PostgreSQL (App-Rolle, RLS,
// Trigger, Fremdschlüssel); danach jeweils der Abgleich der Auslieferung.
//
// Ersetzt: nur die Request-Authentisierung (staffAuth), next/cache, das Log
// und die Object-Store-Aufrufe (`deleteObjectVersion`, `deleteObject`,
// `fetchVerifiedObjectBytes` – jeder Aufruf wird protokolliert; erreicht eine
// Mutation den Speicher eines gebundenen Dokuments, ist das der Befund).
//
// Ausgeführt (Pfade der kanzleikonsole, die Dokumente verändern):
//   Löschen (Bulk-Soft-Delete), Wiederherstellen, Umklassifizieren (Retag, auch
//   in die als Nachweis ausgeschlossenen Klassen), GwG-Vernichtung, hartes
//   Löschen von Dokument/Version/Mandant, neue Version ohne Versions-Route.
//   Nicht vorhanden in der kanzleikonsole (geprüft): „Papierkorb leeren“
//   (kein Endgültig-Löschen von Dokumenten), Ordner verschieben, hartes
//   Löschen eines Mandanten; Rechnungs-/Bescheid-Ablage legen nur neue
//   Dokumente an; die DSGVO-Anonymisierung lässt Dokumente unberührt.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/redteam-dokumente-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001, DOC-RETENTION-CLASS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext, TxClient } from '@taxtronik/db';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const m = vi.hoisted(() => ({
  staff: null as unknown,
  /** Object-Store-Aufrufe der Mutationen: `löschen:<key>` bzw. `lesen:<key>`. */
  speicher: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => m.staff }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@taxtronik/storage', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  deleteObjectVersion: vi.fn(async (_bucket: string, key: string) => {
    m.speicher.push(`löschen:${key}`);
  }),
  deleteObject: vi.fn(async (_bucket: string, key: string) => {
    m.speicher.push(`löschen:${key}`);
  }),
  fetchVerifiedObjectBytes: vi.fn(async (quelle: { key: string }) => {
    m.speicher.push(`lesen:${quelle.key}`);
    throw new Error('RT3B: Object Store im Test nicht vorhanden');
  }),
}));

import {
  meldungsAnlageVerknuepfenTx,
  nachweisAbgleichTx,
  nachweisVerknuepfenTx,
  nachweisVerknuepfungBestaetigen,
  nachweisVerknuepfungFreigeben,
} from '../durchfuehrung/verweis';
import { istNachweisDokumentTx } from '../durchfuehrung/sperre';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const DURCHF = 'cmvfredteam3b0000000001';
const SHA_BYTE = 0x3b;
const GROESSE = 4821n;

(enabled ? describe : describe.skip)(
  'Red Team: Dokument-Mutationen gegen gebundene Nachweise',
  () => {
    let owner!: PrismaClient;
    let app!: PrismaClient;
    let tenantId = '';
    let admin = '';
    let mandant = '';
    /** Mandat seit 2019 beendet: die GwG-Frist eines GwG-Belegs ist abgelaufen. */
    let altMandant = '';
    let typAllgemein = '';
    let typGwg = '';

    const ctx = (): TenantContext => ({ tenantId, actorId: admin, actorType: 'STAFF' });

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
        registerNumber: `HRB-RT3B-${randomUUID()}`,
      });
      await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
      return clientId;
    }

    async function dokument(clientId = mandant) {
      const doc = await owner.document.create({
        data: {
          tenantId,
          clientId,
          title: 'Kontoabstimmung Nachweis',
          classification: 'GENERAL',
          documentTypeId: typAllgemein,
          mimeType: 'application/pdf',
        },
      });
      const version = await owner.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: 'general',
          storageKey: `tenants/${tenantId}/none/${doc.id}.pdf`,
          storageVersionId: 'v1',
          sha256: Buffer.alloc(32, SHA_BYTE),
          sizeBytes: GROESSE,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: admin,
        },
      });
      return { id: doc.id, versionId: version.id, key: version.storageKey };
    }

    /** Nachweis einer Durchführung, vom Dienst angenommen (Nachweis-ID gesetzt). */
    async function alsNachweis(clientId = mandant) {
      const d = await dokument(clientId);
      const { verknuepfungId } = await imTenant((tx) =>
        nachweisVerknuepfenTx(tx, { tenantId, mandantId: clientId, staffId: admin }, d.id, DURCHF),
      );
      expect(
        await nachweisVerknuepfungBestaetigen(
          ctx(),
          verknuepfungId,
          `nw${randomUUID().slice(0, 8)}`,
        ),
      ).toBe(true);
      return { ...d, verknuepfungId };
    }

    /** Anlage einer Ereignismeldung aus dem Portal (Ausgang offen, gesperrt). */
    async function alsMeldungsanlage(clientId = mandant) {
      const d = await dokument(clientId);
      const verknuepfungId = await imTenant((tx) =>
        meldungsAnlageVerknuepfenTx(
          tx,
          { tenantId, mandantId: clientId, kontaktId: randomUUID() },
          d.id,
        ),
      );
      return { ...d, verknuepfungId };
    }

    /** Auslieferung nach der Mutation: Dokument da, Inhalt = Verweis, Sperre offen. */
    async function auslieferbar(d: { id: string }, clientId = mandant) {
      const abgleich = await imTenant((tx) =>
        nachweisAbgleichTx(tx, { tenantId, mandantId: clientId }, [
          {
            id: 'n',
            dokumentId: d.id,
            sha256: Buffer.alloc(32, SHA_BYTE).toString('hex'),
            groesse: Number(GROESSE),
          },
        ]),
      );
      expect(abgleich.get('n'), 'Abgleich der Auslieferung').toBe('OK');
      expect(await imTenant((tx) => istNachweisDokumentTx(tx, d.id)), 'Sperre offen').toBe(true);
    }

    beforeAll(async () => {
      ({ prismaOwner: owner, prisma: app } = await import('@taxtronik/db'));
      tenantId = (
        await owner.tenant.create({
          data: { slug: `tcms-rt3b-dok-${randomUUID()}`, name: 'RT3B Dokumente' },
        })
      ).id;
      admin = (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: `rt3b-${randomUUID()}@example.test`,
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
      mandant = await aktiverMandant('Talwind Outdoor GmbH');
      altMandant = await aktiverMandant('Altmandant GmbH');
      await owner.client.update({
        where: { id: altMandant },
        data: { mandateEndedAt: new Date('2019-06-30T00:00:00Z') },
      });
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
      m.speicher.length = 0;
    });

    afterAll(async () => {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('RT3B-D1: Löschen (Bulk) und Wiederherstellen – gesperrt, nichts gelöscht, Auslieferung unverändert', async () => {
      const nachweis = await alsNachweis();
      const anlage = await alsMeldungsanlage();
      const { softDeleteDocumentsAction, restoreDocumentAction } =
        await import('@/app/staff/(protected)/documents/actions');
      const r = await softDeleteDocumentsAction({
        documentIds: [nachweis.id, anlage.id],
        reason: 'RT3B',
      });
      expect(r.done).toBe(0);
      expect(r.rejected).toHaveLength(2);
      for (const d of [nachweis, anlage]) {
        expect(
          (await owner.document.findUniqueOrThrow({ where: { id: d.id } })).deletedAt,
        ).toBeNull();
        await auslieferbar(d);
      }
      // Wiederherstellen eines (nicht gelöschten) gebundenen Dokuments ändert nichts.
      expect(await restoreDocumentAction({ documentId: nachweis.id })).toMatchObject({ ok: false });
      expect(m.speicher).toEqual([]);
    });

    it('RT3B-D2: hartes Löschen von Dokument, Version und Mandant sowie Soft-Delete der Owner-Rolle – abgewiesen', async () => {
      const d = await alsNachweis();
      await expect(owner.documentVersion.delete({ where: { id: d.versionId } })).rejects.toThrow();
      await expect(owner.document.delete({ where: { id: d.id } })).rejects.toThrow();
      await expect(owner.client.delete({ where: { id: mandant } })).rejects.toThrow();
      await expect(
        owner.document.update({ where: { id: d.id }, data: { deletedAt: new Date() } }),
      ).rejects.toThrow(/als Nachweis im Tax-CMS verknüpft/);
      await auslieferbar(d);
    });

    it('RT3B-D3: neue Version an der Versions-Route vorbei – keine DB-Sperre, aber der Abgleich liefert nicht aus', async () => {
      const d = await alsNachweis();
      const neueVersion = () =>
        owner.documentVersion.create({
          data: {
            documentId: d.id,
            versionNo: 2,
            storageBucket: 'general',
            storageKey: `tenants/${tenantId}/none/${d.id}-2.pdf`,
            sha256: Buffer.alloc(32, 0x99),
            sizeBytes: GROESSE,
            immutable: false,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            createdById: admin,
          },
        });
      // Seit der Härtung D3 sperrt document_version_tcms_reference_guard neue
      // Versionen gebundener Dokumente auch an der Route vorbei (jede Rolle, hier
      // die Owner-Rolle); der Nachweis bleibt auslieferbar.
      const fehler = await neueVersion().then(
        () => null,
        (e: unknown) => e,
      );
      expect(dbAbweisung(fehler), 'neue Version gesperrt').toEqual({
        sqlState: '23001',
        meldung: expect.stringMatching(/als Nachweis im Tax-CMS verknüpft, neue Version gesperrt/),
      });
      await auslieferbar(d);
      // Die Auslieferung vergleicht weiter die NEUESTE Version mit dem Verweis: nach
      // der Freigabe (Nachweis entfernt) ist eine neue Version möglich, der alte
      // Verweis wird dann nicht mehr ausgeliefert.
      await nachweisVerknuepfungFreigeben(ctx(), { verknuepfungId: d.verknuepfungId }, 'REMOVED');
      await neueVersion();
      const abgleich = await imTenant((tx) =>
        nachweisAbgleichTx(tx, { tenantId, mandantId: mandant }, [
          {
            id: 'n',
            dokumentId: d.id,
            sha256: Buffer.alloc(32, SHA_BYTE).toString('hex'),
            groesse: Number(GROESSE),
          },
        ]),
      );
      expect(abgleich.get('n')).toBe('ABWEICHUNG');
    });

    it.each(['GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE'] as const)(
      'RT3B-K-01a: Umklassifizieren eines gebundenen Nachweises nach %s wird abgewiesen, bevor der Speicher berührt wird',
      async (klasse) => {
        const d = await alsNachweis();
        const { retagDocumentsAction } = await import('@/app/staff/(protected)/documents/actions');
        const r = await retagDocumentsAction({ documentIds: [d.id], classification: klasse });
        const nachher = await owner.document.findUniqueOrThrow({ where: { id: d.id } });
        // Erwartet (TCMS-NACHWEIS-001: GwG-, Personal- und private Dokumente sind
        // nie Nachweis): Ablehnung wie beim Löschen, Klassifikation unverändert,
        // kein Zugriff auf den Object Store.
        expect({
          klassifikation: nachher.classification,
          speicher: m.speicher,
          abgewiesen: r.rejected.length,
        }).toEqual({ klassifikation: 'GENERAL', speicher: [], abgewiesen: 1 });
      },
    );

    /** GwG-Beleg eines seit 2019 beendeten Mandats, Object-Lock abgelaufen (Vernichtung fällig). */
    async function faelligerGwgBeleg(d: { id: string }) {
      await owner.document.update({
        where: { id: d.id },
        data: {
          classification: 'GWG_EVIDENCE',
          documentTypeId: typGwg,
          retentionUntil: new Date('2025-01-01T00:00:00Z'),
          createdAt: new Date('2019-01-15T00:00:00Z'),
        },
      });
    }

    /** SQLSTATE und Meldung der Datenbank (nie die zusammengesetzte Prisma-Meldung mit Codeausschnitt). */
    function dbAbweisung(fehler: unknown): { sqlState: unknown; meldung: unknown } | null {
      const ursache = (
        fehler as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null
      )?.meta?.driverAdapterError?.cause;
      return ursache
        ? { sqlState: ursache['originalCode'], meldung: ursache['originalMessage'] }
        : null;
    }

    /**
     * Zustand nach einem Retag GENERAL → GWG_EVIDENCE (K-01a). Seit der Behebung
     * weist die Datenbank diesen Wechsel eines gebundenen Dokuments für jede Rolle
     * ab (document_tcms_reference_scope_guard) – auch für die Owner-Rolle, mit der
     * der Angriff ihn hergestellt hat. Der Angriff belegt das und vernichtet danach
     * das gebundene, sonst fällige Dokument: Aktion und Claim prüfen die Bindung
     * vor Klassifikation und Frist, also auf demselben Weg wie bei Altbestand, der
     * vor der Behebung umklassifiziert wurde (Altbestand selbst: packages/db,
     * tcms-document-reference-guards.test.ts, nur mit Superuser herstellbar).
     */
    async function gebundenerFaelligerBeleg(d: { id: string }) {
      const fehler = await faelligerGwgBeleg(d).then(
        () => null,
        (e: unknown) => e,
      );
      expect(dbAbweisung(fehler), 'Umklassifizieren gesperrt (Owner-Rolle)').toEqual({
        sqlState: '23001',
        meldung: expect.stringMatching(/als Nachweis im Tax-CMS verknüpft/),
      });
      await owner.document.update({
        where: { id: d.id },
        data: {
          retentionUntil: new Date('2025-01-01T00:00:00Z'),
          createdAt: new Date('2019-01-15T00:00:00Z'),
        },
      });
      expect((await owner.document.findUniqueOrThrow({ where: { id: d.id } })).classification).toBe(
        'GENERAL',
      );
    }

    it('RT3B-K-01b: GwG-Vernichtung eines gebundenen Nachweises wird wegen der Tax-CMS-Bindung abgewiesen, ohne Bytes zu löschen', async () => {
      // Zustand nach einem Retag GENERAL → GWG_EVIDENCE (K-01a) – seit der Behebung abgewiesen.
      const d = await alsNachweis(altMandant);
      await gebundenerFaelligerBeleg(d);
      const { confirmGwgDeletionAction } =
        await import('@/app/staff/(protected)/admin/gwg-retention/actions');
      const r = await confirmGwgDeletionAction({ documentId: d.id });
      const zeile = await owner.tcmsDocumentReference.findUniqueOrThrow({
        where: { id: d.verknuepfungId },
      });
      // Erwartet: Abweisung WEGEN der Bindung (nicht zufällig an K-02) und vor jedem
      // Object-Store-Aufruf; die Verknüpfung bleibt offen.
      expect({
        ok: r.ok,
        grundTaxCms: !r.ok && /Tax-CMS/.test(r.error ?? ''),
        geloeschteObjekte: m.speicher.filter((s) => s.startsWith('löschen:')),
        verknuepfungOffen: zeile.releasedAt === null,
      }).toEqual({ ok: false, grundTaxCms: true, geloeschteObjekte: [], verknuepfungOffen: true });
    });

    it('RT3B-K-01c: der DB-Claim der GwG-Vernichtung lässt einen gebundenen Nachweis zu – erst die DB-Vernichtung danach scheitert (Bytes schon weg)', async () => {
      const d = await alsNachweis(altMandant);
      await gebundenerFaelligerBeleg(d);
      const { Prisma } = await import('@taxtronik/db/prisma-client');
      const claimUndVernichtung = (vernichten: boolean) =>
        imTenant(async (tx) => {
          await tx.document.updateMany({
            where: { id: d.id },
            data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: admin },
          });
          // Wie confirmGwgDeletionAction (Zeile 151), mit Cast wegen K-02.
          await tx.$queryRaw(
            Prisma.sql`SELECT app.assert_gwg_document_destruction_due(${d.id}::uuid)::text AS ok`,
          );
          if (vernichten) {
            await tx.$queryRaw(
              Prisma.sql`SELECT app.destroy_gwg_document_versions(${d.id}::uuid) AS geloescht`,
            );
          }
          // Nichts festschreiben: der Test prüft nur, welcher Schritt abweist.
          throw new Error('RT3B: Rücknahme');
        });
      // Reihenfolge der Aktion: Claim → Object-Store-Löschung → DB-Vernichtung.
      // Die DB-Vernichtung scheitert an Fremdschlüssel/Trigger der Bindung …
      await expect(claimUndVernichtung(true)).rejects.toThrow(
        /tcms_document_reference|als Nachweis im Tax-CMS verknüpft/,
      );
      // … der Claim davor muss die Bindung erkennen; sonst löscht die Aktion
      // die Bytes, bevor eine Sperre greift.
      await expect(claimUndVernichtung(false)).rejects.toThrow(/Tax-CMS/);
    });

    it('RT3B-K-02: GwG-Vernichtung eines fälligen, ungebundenen GwG-Belegs ist ausführbar (Claim liefert void)', async () => {
      const d = await dokument(altMandant);
      await faelligerGwgBeleg(d);
      const { confirmGwgDeletionAction } =
        await import('@/app/staff/(protected)/admin/gwg-retention/actions');
      const r = await confirmGwgDeletionAction({ documentId: d.id });
      // Heute: `SELECT app.assert_gwg_document_destruction_due(…)` liefert `void`,
      // Prisma bricht beim Lesen ab („Failed to deserialize column of type
      // 'void'“) – jede Vernichtung scheitert am Claim, keine Frist ist erfüllbar.
      expect({ ok: r.ok, geloescht: m.speicher }).toEqual({
        ok: true,
        geloescht: [`löschen:${d.key}`],
      });
      expect(
        (await owner.document.findUniqueOrThrow({ where: { id: d.id } })).gwgDestroyedAt,
      ).not.toBeNull();
    });
  },
);
