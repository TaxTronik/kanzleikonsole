// Fachkatalog: TCMS-NACHWEIS-001, DOC-VERSION-IMMUTABILITY-001, ACCESS-TENANT-RLS-001
// TCMS Stufe 3 (Bereich C): Verknüpfung von Nachweisen des Tax-CMS mit
// Dokumenten der kanzleikonsole gegen echtes PostgreSQL über die App-Rolle
// (RLS, Trigger): Verweis nur aus der gespeicherten neuesten sauberen Version
// eines Dokuments genau dieses Mandanten; Bezug unveränderlich; Soft-Delete
// gesperrt, solange die Verknüpfung offen ist; ein paralleles Löschen und
// Verknüpfen serialisieren sich über die Dokumentzeile.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext, TxClient } from '@taxtronik/db';
import { NachweisVerweisSchema } from '@taxtronik/tcms-contract';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const fixture = vi.hoisted(() => ({
  run: async (_ctx: TenantContext, _fn: (tx: TxClient) => unknown): Promise<unknown> => undefined,
}));
vi.mock('@taxtronik/db/tenant-context', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  withTenantContext: (ctx: TenantContext, fn: (tx: TxClient) => unknown) => fixture.run(ctx, fn),
}));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// Der Abgleich liest über die Seite (server-only); hier zählen nur seine
// Datenbankteile (offene Verknüpfungen, Entscheidung).
vi.mock('@/server/tcms/seite', () => ({ tcmsLesenOptional: vi.fn(), tcmsTenantLesen: vi.fn() }));

import {
  meldungsAnlagenFreigeben,
  meldungsAnlagenZuordnen,
  meldungsAnlageVerknuepfenTx,
  nachweisAbgleichTx,
  NachweisDokumentUnzulaessig,
  nachweisDokumenteTx,
  nachweisVerknuepfenTx,
  nachweisVerknuepfungBestaetigen,
  nachweisVerknuepfungFreigeben,
} from '../durchfuehrung/verweis';
import { istNachweisDokumentTx } from '../durchfuehrung/sperre';
import { abgleichEntscheidung, offeneVerknuepfungenTx } from '../durchfuehrung/abgleich';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const DURCHF = 'cmvf9pzy3003jfu7d4oo44g6s';

/**
 * Meldung eines Datenbankfehlers ohne den Codeausschnitt, den Prisma an die
 * Fehlermeldung hängt: Er zeigt die Zeilen um den Aufruf – oft samt dem
 * erwarteten Muster dieses Tests – und ließe `toThrow(/…/)` sonst auch dann
 * bestehen, wenn die Datenbank aus einem anderen Grund ablehnt.
 */
function ohneCodeausschnitt(text: string): string {
  const zeilen = text.split('\n');
  let letzte = -1;
  zeilen.forEach((zeile, i) => {
    if (/^\s*(?:→\s*)?\d+\s/.test(zeile)) letzte = i;
  });
  return zeilen.slice(letzte + 1).join('\n');
}

/** Erwartet eine Ablehnung, deren Meldung (ohne Codeausschnitt) `muster` trifft. */
async function abgewiesen(aufruf: Promise<unknown>, muster: RegExp): Promise<void> {
  const fehler = await aufruf.then(
    () => null,
    (e: unknown) => e,
  );
  expect(fehler, 'erwartet: Ablehnung').toBeInstanceOf(Error);
  expect(ohneCodeausschnitt((fehler as Error).message)).toMatch(muster);
}

(enabled ? describe : describe.skip)('Nachweis-Verknüpfungen (TCMS-NACHWEIS-001)', () => {
  // Freigegebene Clients aus @taxtronik/db (prisma-client-guard): Owner nur für
  // Fixtures, die App-Rolle (DATABASE_APP_URL, RLS) für alle Prüfungen. Erst im
  // beforeAll geladen, damit eine übersprungene Suite keine Verbindung braucht.
  let owner!: PrismaClient;
  let app!: PrismaClient;
  let tenantId = '';
  let fremderTenant = '';
  let staffId = '';
  let mandant = '';
  let andererMandant = '';
  let typ = '';

  /** Transaktion der App-Rolle im Tenant (wie withTenantContext). */
  function imTenant<T>(fn: (tx: TxClient) => Promise<T>, tenant = tenantId): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenant},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
      return fn(tx as unknown as TxClient);
    }) as Promise<T>;
  }

  async function aktiverMandant(tenant: string, name: string, verifiedBy: string) {
    const clientId = (
      await owner.client.create({
        data: { tenantId: tenant, kind: 'JURPERS', name, allowActive: false },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId: tenant,
      clientId,
      verifiedBy,
      registerNumber: `HRB-NW-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    return clientId;
  }

  interface DokumentOptionen {
    clientId?: string;
    titel?: string;
    mime?: string;
    classification?: 'GENERAL' | 'PERSONNEL';
    requiresPayrollAccess?: boolean;
    versionen?: Array<{ scanStatus: 'CLEAN' | 'PENDING'; byte: number; groesse?: bigint }>;
  }

  async function dokument(o: DokumentOptionen = {}) {
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId: o.clientId ?? mandant,
        title: o.titel ?? 'Kontoabstimmung September',
        classification: o.classification ?? 'GENERAL',
        documentTypeId: typ,
        mimeType: o.mime ?? 'application/pdf',
        requiresPayrollAccess: o.requiresPayrollAccess ?? false,
      },
    });
    const versionen = o.versionen ?? [{ scanStatus: 'CLEAN' as const, byte: 7 }];
    const ids: string[] = [];
    for (const [i, v] of versionen.entries()) {
      ids.push(
        (
          await owner.documentVersion.create({
            data: {
              documentId: doc.id,
              versionNo: i + 1,
              storageBucket: 'general',
              storageKey: `tenants/${tenantId}/none/${doc.id}-${i}.bin`,
              sha256: Buffer.alloc(32, v.byte),
              sizeBytes: v.groesse ?? 4821n,
              immutable: false,
              scanStatus: v.scanStatus,
              scanCompletedAt: v.scanStatus === 'CLEAN' ? new Date() : null,
              createdById: staffId,
            },
          })
        ).id,
      );
    }
    return { id: doc.id, versionen: ids };
  }

  const bezug = () => ({ tenantId, mandantId: mandant, staffId });

  beforeAll(async () => {
    ({ prismaOwner: owner, prisma: app } = await import('@taxtronik/db'));
    const neu = async (name: string) =>
      (await owner.tenant.create({ data: { slug: `tcms-nw-${randomUUID()}`, name } })).id;
    tenantId = await neu('TCMS Nachweise');
    fremderTenant = await neu('TCMS Nachweise fremd');
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `nw-${randomUUID()}@example.test`,
          fullName: 'Leon Brandt',
          passwordHash: 'synthetic',
          roles: { create: [{ role: 'EMPLOYEE' }] },
        },
      })
    ).id;
    mandant = await aktiverMandant(tenantId, 'Talwind Outdoor GmbH', staffId);
    andererMandant = await aktiverMandant(tenantId, 'Seestern GmbH', staffId);
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
    fixture.run = (ctx, fn) => imTenant(fn as (tx: TxClient) => Promise<unknown>, ctx.tenantId);
  });

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  it('bildet den Verweis aus der gespeicherten neuesten Version und legt die Verknüpfung an', async () => {
    const d = await dokument({ titel: 'Kontoabstimmung/September\u202e', mime: 'APPLICATION/PDF' });
    const { verknuepfungId, verweis } = await imTenant((tx) =>
      nachweisVerknuepfenTx(tx, bezug(), d.id, DURCHF),
    );
    expect(NachweisVerweisSchema.parse(verweis)).toEqual(verweis);
    expect(verweis).toEqual({
      dokumentId: d.id,
      // Pfadtrenner ersetzt, Richtungszeichen entfernt (Zeichenregel des
      // Vertrags, TCMS s8), Endung aus dem geprüften Typ.
      dateiname: 'Kontoabstimmung_September.pdf',
      mime: 'application/pdf',
      groesse: 4821,
      sha256: '07'.repeat(32),
    });
    const zeile = await owner.tcmsDocumentReference.findUniqueOrThrow({
      where: { id: verknuepfungId },
    });
    expect(zeile).toMatchObject({
      tenantId,
      clientId: mandant,
      documentId: d.id,
      documentVersionId: d.versionen[0],
      tcmsExecutionId: DURCHF,
      tcmsEvidenceId: null,
      createdBy: staffId,
      releasedAt: null,
    });
    expect(Buffer.from(zeile.sha256).toString('hex')).toBe('07'.repeat(32));
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d.id))).toBe(true);
  });

  it('nur Dokumente dieses Mandanten, nicht gelöscht, sauber gescannt, ohne Personal- und Lohnbezug', async () => {
    const fremd = await dokument({ clientId: andererMandant });
    const ungescannt = await dokument({
      versionen: [
        { scanStatus: 'CLEAN', byte: 1 },
        { scanStatus: 'PENDING', byte: 2 },
      ],
    });
    const personal = await dokument({ classification: 'PERSONNEL' });
    const lohn = await dokument({ requiresPayrollAccess: true });
    const geloescht = await dokument();
    await owner.document.update({
      where: { id: geloescht.id },
      data: { deletedAt: new Date(), deletedByStaff: staffId },
    });
    for (const id of [fremd.id, ungescannt.id, personal.id, lohn.id, geloescht.id, randomUUID()]) {
      await expect(
        imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), id, DURCHF)),
      ).rejects.toBeInstanceOf(NachweisDokumentUnzulaessig);
    }
    expect(
      await owner.tcmsDocumentReference.count({ where: { tenantId, clientId: andererMandant } }),
    ).toBe(0);
    // Die Auswahlliste zeigt keines davon.
    const wahl = await imTenant((tx) => nachweisDokumenteTx(tx, bezug()));
    const ids = wahl.map((w) => w.id);
    for (const id of [fremd.id, ungescannt.id, personal.id, lohn.id, geloescht.id]) {
      expect(ids).not.toContain(id);
    }
  });

  it('der Trigger lässt weder ältere Versionen noch abweichende SHA-256 noch fremde Mandanten zu', async () => {
    const d = await dokument({
      versionen: [
        { scanStatus: 'CLEAN', byte: 3 },
        { scanStatus: 'CLEAN', byte: 4 },
      ],
    });
    const anlegen = (daten: { versionId: string; byte: number; clientId?: string }) =>
      imTenant((tx) =>
        tx.tcmsDocumentReference.create({
          data: {
            tenantId,
            clientId: daten.clientId ?? mandant,
            documentId: d.id,
            documentVersionId: daten.versionId,
            sha256: Buffer.alloc(32, daten.byte),
            tcmsSubject: 'EXECUTION',
            tcmsExecutionId: DURCHF,
            createdBy: staffId,
          },
        }),
      );
    await abgewiesen(anlegen({ versionId: d.versionen[0]!, byte: 3 }), /neueste, saubere Version/);
    await abgewiesen(anlegen({ versionId: d.versionen[1]!, byte: 9 }), /neueste, saubere Version/);
    await abgewiesen(
      anlegen({ versionId: d.versionen[1]!, byte: 4, clientId: andererMandant }),
      /nicht verfügbar/,
    );
    await expect(anlegen({ versionId: d.versionen[1]!, byte: 4 })).resolves.toBeTruthy();
  });

  it('Bezug und Inhalt unveränderlich, Nachweis-ID einmal, Freigabe endgültig, kein Löschen', async () => {
    const d = await dokument();
    const { verknuepfungId } = await imTenant((tx) =>
      nachweisVerknuepfenTx(tx, bezug(), d.id, DURCHF),
    );
    const aendern = (data: Record<string, unknown>) =>
      imTenant((tx) => tx.tcmsDocumentReference.update({ where: { id: verknuepfungId }, data }));
    await abgewiesen(aendern({ sha256: Buffer.alloc(32, 1) }), /unveränderlich/);
    await abgewiesen(aendern({ tcmsExecutionId: 'anderedurchfuehrung' }), /unveränderlich/);
    expect(
      await nachweisVerknuepfungBestaetigen(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        verknuepfungId,
        'nachweisaaa1',
      ),
    ).toBe(true);
    await abgewiesen(aendern({ tcmsEvidenceId: 'nachweisbbb2' }), /nur einmal/);
    expect(
      await nachweisVerknuepfungFreigeben(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        { mandantId: mandant, durchfuehrungId: DURCHF, nachweisId: 'nachweisaaa1' },
        'REMOVED',
      ),
    ).toBe(1);
    await abgewiesen(
      aendern({ releasedAt: null, releasedBy: null, releaseReason: null }),
      /endgültig/,
    );
    // Eine zweite Freigabe (z. B. erneutes Entfernen) ändert nichts und scheitert nicht.
    expect(
      await nachweisVerknuepfungFreigeben(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        { mandantId: mandant, durchfuehrungId: DURCHF, nachweisId: 'nachweisaaa1' },
        'NOT_ATTACHED',
      ),
    ).toBe(0);
    await expect(
      imTenant((tx) => tx.tcmsDocumentReference.delete({ where: { id: verknuepfungId } })),
    ).rejects.toThrow();
    expect(await owner.tcmsDocumentReference.count({ where: { id: verknuepfungId } })).toBe(1);
  });

  it('Abgleich (TCMS s7): nur offene ohne Nachweis-ID dieser Durchführung, älter als die Grenze; Bestätigen bzw. Freigeben', async () => {
    const DF = 'cmvf9abgleich0001xyzabc';
    const d1 = await dokument();
    const d2 = await dokument();
    const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
    const a = await imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), d1.id, DF));
    const b = await imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), d2.id, DF));
    // Bereits bestätigt und andere Durchführung: nicht offen im Sinne des Abgleichs.
    const c = await imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), d1.id, DURCHF));
    await nachweisVerknuepfungBestaetigen(ctx, c.verknuepfungId, 'nachweisccc3');
    const jetzt = new Date(Date.now() + 1000);
    const lesen = (bis: Date) =>
      imTenant((tx) => offeneVerknuepfungenTx(tx, { tenantId, mandantId: mandant }, DF, bis));
    // Jünger als die Grenze: nichts.
    expect((await lesen(new Date(Date.now() - 60_000))).offen).toEqual([]);
    const r = await lesen(jetzt);
    expect(r.offen.map((v) => v.id).sort()).toEqual([a.verknuepfungId, b.verknuepfungId].sort());
    expect(r.gebunden).toEqual(new Set(['nachweisccc3']));
    // Fremder Tenant sieht nichts (RLS), anderer Mandant ebenso.
    expect(
      (
        await imTenant((tx) =>
          offeneVerknuepfungenTx(tx, { tenantId, mandantId: andererMandant }, DF, jetzt),
        )
      ).offen,
    ).toEqual([]);
    // Entscheidungen des Abgleichs schreiben wie die Aktionen.
    const va = r.offen.find((v) => v.id === a.verknuepfungId)!;
    const e = abgleichEntscheidung(
      va,
      {
        dokumentId: d1.id,
        nachweise: [{ id: 'nachweisaaa9', durchfuehrungId: DF, entfernt: false }],
      },
      r.gebunden,
    );
    expect(e).toEqual({ art: 'BESTAETIGEN', nachweisId: 'nachweisaaa9' });
    expect(await nachweisVerknuepfungBestaetigen(ctx, va.id, 'nachweisaaa9')).toBe(true);
    expect(
      await nachweisVerknuepfungFreigeben(
        ctx,
        { verknuepfungId: b.verknuepfungId },
        'NOT_ATTACHED',
      ),
    ).toBe(1);
    expect((await lesen(jetzt)).offen).toEqual([]);
    const zeile = await owner.tcmsDocumentReference.findUniqueOrThrow({
      where: { id: b.verknuepfungId },
    });
    expect(zeile).toMatchObject({ releaseReason: 'NOT_ATTACHED', releasedBy: staffId });
    // Bestätigt: Dokument bleibt gesperrt; freigegeben: wieder frei.
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d1.id))).toBe(true);
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d2.id))).toBe(false);
  });

  it('sperrt das Soft-Delete, solange die Verknüpfung offen ist (jeder Pfad)', async () => {
    const d = await dokument();
    const { verknuepfungId } = await imTenant((tx) =>
      nachweisVerknuepfenTx(tx, bezug(), d.id, DURCHF),
    );
    const loeschen = () =>
      imTenant((tx) =>
        tx.document.update({
          where: { id: d.id },
          data: { deletedAt: new Date(), deletedByStaff: staffId },
        }),
      );
    await abgewiesen(loeschen(), /als Nachweis im Tax-CMS verknüpft/);
    // Auch die Owner-Rolle (Worker, Migrationen) löscht nicht still.
    await abgewiesen(
      owner.document.update({ where: { id: d.id }, data: { deletedAt: new Date() } }),
      /als Nachweis im Tax-CMS verknüpft/,
    );
    // Hartes Löschen verhindert der Fremdschlüssel.
    await expect(owner.document.delete({ where: { id: d.id } })).rejects.toThrow();
    // Nach eindeutiger Ablehnung des Anhängens ist das Dokument wieder frei.
    await nachweisVerknuepfungFreigeben(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      { verknuepfungId },
      'NOT_ATTACHED',
    );
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d.id))).toBe(false);
    await expect(loeschen()).resolves.toMatchObject({ id: d.id });
  });

  it('Meldungsanlagen (TCMS s7): genau ein Bezug, Ereignis-ID einmal, Löschsperre für App- und Owner-Rolle, Freigabe nach Verwerfen', async () => {
    const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
    const kontakt = randomUUID();
    const d = await dokument();
    const id = await imTenant((tx) =>
      meldungsAnlageVerknuepfenTx(tx, { tenantId, mandantId: mandant, kontaktId: kontakt }, d.id),
    );
    expect(await owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id } })).toMatchObject({
      tcmsSubject: 'EVENT',
      tcmsExecutionId: null,
      tcmsEvidenceId: null,
      tcmsEventId: null,
      createdBy: kontakt,
      documentVersionId: d.versionen[0],
    });
    // Gesperrt, solange offen – auch ohne Ereignis-ID (Ausgang der Meldung offen).
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d.id))).toBe(true);
    const appLoeschen = () =>
      imTenant((tx) =>
        tx.document.update({
          where: { id: d.id },
          data: { deletedAt: new Date(), deletedByStaff: staffId },
        }),
      );
    const ownerLoeschen = () =>
      owner.document.update({ where: { id: d.id }, data: { deletedAt: new Date() } });
    await abgewiesen(appLoeschen(), /als Nachweis im Tax-CMS verknüpft/);
    await abgewiesen(ownerLoeschen(), /als Nachweis im Tax-CMS verknüpft/);

    // Genau ein Bezug: keine Durchführung, keine Nachweis-ID, Bezug unveränderlich.
    const aendern = (data: Record<string, unknown>) =>
      imTenant((tx) => tx.tcmsDocumentReference.update({ where: { id }, data }));
    await abgewiesen(aendern({ tcmsExecutionId: DURCHF }), /unveränderlich/);
    await abgewiesen(aendern({ tcmsSubject: 'EXECUTION' }), /unveränderlich/);
    await abgewiesen(aendern({ tcmsEvidenceId: 'nachweisfff1' }), /subject_check/);
    const roh = (data: Record<string, unknown>) =>
      imTenant((tx) =>
        tx.tcmsDocumentReference.create({
          data: {
            tenantId,
            clientId: mandant,
            documentId: d.id,
            documentVersionId: d.versionen[0]!,
            sha256: Buffer.alloc(32, 7),
            createdBy: staffId,
            tcmsSubject: 'EVENT',
            ...data,
          },
        }),
      );
    await abgewiesen(roh({ tcmsExecutionId: DURCHF }), /subject_check/);
    await abgewiesen(roh({ tcmsSubject: 'EXECUTION' }), /subject_check/);
    await abgewiesen(roh({ tcmsSubject: 'ANDERES' }), /subject_check/);

    // Ereignis-ID: Format der Objekt-IDs, nur offene, höchstens einmal.
    await abgewiesen(meldungsAnlagenZuordnen(ctx, [id], 'Ereignis-1'), /event_id_check/);
    expect(await meldungsAnlagenZuordnen(ctx, [id], 'ereignisaaa1')).toBe(1);
    expect(await meldungsAnlagenZuordnen(ctx, [id], 'ereignisbbb2')).toBe(0);
    await abgewiesen(aendern({ tcmsEventId: 'ereignisbbb2' }), /nur einmal/);
    // Freigabe der Nachweise trifft keine Meldungsanlage; „entfernt“ gibt es dort nicht.
    expect(await nachweisVerknuepfungFreigeben(ctx, { verknuepfungId: id }, 'NOT_ATTACHED')).toBe(
      0,
    );
    await abgewiesen(
      aendern({ releasedAt: new Date(), releasedBy: staffId, releaseReason: 'REMOVED' }),
      /subject_check/,
    );
    // Verwerfen: nur Anlagen dieses Ereignisses dieses Mandanten, nur im eigenen Tenant.
    expect(
      await meldungsAnlagenFreigeben(
        ctx,
        { mandantId: andererMandant, ereignisId: 'ereignisaaa1' },
        'DISCARDED',
      ),
    ).toBe(0);
    expect(
      await meldungsAnlagenFreigeben(
        { ...ctx, tenantId: fremderTenant },
        { mandantId: mandant, ereignisId: 'ereignisaaa1' },
        'DISCARDED',
      ),
    ).toBe(0);
    expect(
      await meldungsAnlagenFreigeben(
        ctx,
        { mandantId: mandant, ereignisId: 'ereignisaaa1' },
        'DISCARDED',
      ),
    ).toBe(1);
    expect(await owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id } })).toMatchObject({
      releaseReason: 'DISCARDED',
      releasedBy: staffId,
      tcmsEventId: 'ereignisaaa1',
    });
    await abgewiesen(aendern({ tcmsEventId: null }), /nur einmal/);
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d.id))).toBe(false);
    await expect(appLoeschen()).resolves.toMatchObject({ id: d.id });

    // Meldung nie angenommen: Freigabe der Verknüpfungen dieses Vorgangs.
    const d2 = await dokument();
    const offen = await imTenant((tx) =>
      meldungsAnlageVerknuepfenTx(tx, { tenantId, mandantId: mandant, kontaktId: kontakt }, d2.id),
    );
    expect(await meldungsAnlagenFreigeben(ctx, { verknuepfungIds: [offen] }, 'NOT_ATTACHED')).toBe(
      1,
    );
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d2.id))).toBe(false);

    // Ein Nachweis einer Durchführung wird nie „verworfen“ und nie einem Ereignis zugeordnet.
    const d3 = await dokument();
    const n = await imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), d3.id, DURCHF));
    const nachweisAendern = (data: Record<string, unknown>) =>
      imTenant((tx) => tx.tcmsDocumentReference.update({ where: { id: n.verknuepfungId }, data }));
    await abgewiesen(nachweisAendern({ tcmsEventId: 'ereignisccc3' }), /subject_check/);
    await abgewiesen(
      nachweisAendern({ releasedAt: new Date(), releasedBy: staffId, releaseReason: 'DISCARDED' }),
      /subject_check/,
    );
    expect(await meldungsAnlagenZuordnen(ctx, [n.verknuepfungId], 'ereignisccc3')).toBe(0);
    // Die Freigabe der Meldungsanlagen trifft nie einen Nachweis.
    expect(
      await meldungsAnlagenFreigeben(ctx, { verknuepfungIds: [n.verknuepfungId] }, 'NOT_ATTACHED'),
    ).toBe(0);
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d3.id))).toBe(true);
  });

  it('RLS: ein anderer Tenant sieht keine Verknüpfungen', async () => {
    const d = await dokument();
    await imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), d.id, DURCHF));
    const sichtbar = await imTenant(
      (tx) => tx.tcmsDocumentReference.count({ where: { documentId: d.id } }),
      fremderTenant,
    );
    expect(sichtbar).toBe(0);
    expect(await imTenant((tx) => istNachweisDokumentTx(tx, d.id), fremderTenant)).toBe(false);
  });

  it('Abgleich: gleich, abweichend oder nicht verfügbar', async () => {
    const gleich = await dokument();
    const neu = await dokument({
      versionen: [
        { scanStatus: 'CLEAN', byte: 5 },
        { scanStatus: 'CLEAN', byte: 6 },
      ],
    });
    const fremd = await dokument({ clientId: andererMandant });
    const abgleich = await imTenant((tx) =>
      nachweisAbgleichTx(tx, bezug(), [
        { id: 'n1', dokumentId: gleich.id, sha256: '07'.repeat(32), groesse: 4821 },
        { id: 'n2', dokumentId: neu.id, sha256: '05'.repeat(32), groesse: 4821 },
        { id: 'n3', dokumentId: gleich.id, sha256: '07'.repeat(32), groesse: 1 },
        { id: 'n4', dokumentId: fremd.id, sha256: '07'.repeat(32), groesse: 4821 },
        { id: 'n5', dokumentId: '45/456ba7a4e9', sha256: '07'.repeat(32), groesse: 4821 },
      ]),
    );
    expect(Object.fromEntries(abgleich)).toEqual({
      n1: 'OK',
      n2: 'ABWEICHUNG',
      n3: 'ABWEICHUNG',
      n4: 'FEHLT',
      n5: 'FEHLT',
    });
  });

  it('paralleles Löschen und Verknüpfen: wer zuerst sperrt, gewinnt – nie beides', async () => {
    const d = await dokument();
    let freigeben!: () => void;
    const halten = new Promise<void>((resolve) => (freigeben = resolve));
    let gesperrt!: () => void;
    const sperreGehalten = new Promise<void>((resolve) => (gesperrt = resolve));
    // Löschaktion: Dokumentzeile sperren und ausblenden, Commit erst später.
    const loeschung = imTenant(async (tx) => {
      await tx.$queryRaw`SELECT d.id FROM document d WHERE d.id = ${d.id}::uuid FOR UPDATE OF d`;
      await tx.document.update({
        where: { id: d.id },
        data: { deletedAt: new Date(), deletedByStaff: staffId },
      });
      gesperrt();
      await halten;
    });
    // Erst wenn die Löschaktion die Zeile hält (sonst entscheidet der Zufall die
    // Reihenfolge): Verknüpfen wartet auf die Sperre und scheitert nach dem Commit.
    await sperreGehalten;
    const verknuepfung = imTenant((tx) => nachweisVerknuepfenTx(tx, bezug(), d.id, DURCHF));
    const started = Date.now();
    for (;;) {
      const [zeile] = await owner.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database()`;
      if ((zeile?.waiting ?? 0) > 0 || Date.now() - started > 5000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    freigeben();
    await loeschung;
    await expect(verknuepfung).rejects.toBeInstanceOf(NachweisDokumentUnzulaessig);
    expect(await owner.tcmsDocumentReference.count({ where: { documentId: d.id } })).toBe(0);
  });
});
