// =============================================================================
// kk-tcms-s10nach (TCMS s10): idempotente Ereignismeldung aus dem Portal gegen
// echtes PostgreSQL (App-Rolle unter RLS, Tenant-Kontext des Kontakts). Der
// Dienst ist eine zustandsbehaftete Attrappe mit der Idempotenz des Tax-CMS
// (je Schlüssel ein Ereignis, gleicher Inhalt → dieselbe Antwort, anderer
// Inhalt → 409 IDEMPOTENZ_ABWEICHUNG); die Live-Suite bereich-d-live prüft
// dasselbe gegen den echten Dienst.
//
// Schutzregeln (TCMS-NACHWEIS-001):
//   - Transportfehler NACH erfolgreicher Anlage im Dienst: Der zweite Versuch
//     (gleiches Formular oder Klärung beim nächsten Öffnen) nutzt denselben
//     Schlüssel und Inhalt, liefert dasselbe Ereignis, die Bindung ist
//     abgeschlossen (Ereignis-ID), der Inhalt gelöscht.
//   - Der Inhalt liegt nur verschlüsselt am Vorgang und nur bis zur Klärung.
//   - Eine Ablehnung einer Wiederholung klärt nichts (Anlagen bleiben gebunden).
//   - Nach Ablauf des Fensters: keine Wiederholung, nie frei – „ungeklärte
//     Anlage“ für die Kanzlei.
//   - Nur die Person der Sitzung wiederholt ihre eigenen Vorgänge.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/meldevorgang-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext } from '@taxtronik/db';
import {
  TcmsKonflikt,
  TcmsNichtBerechtigt,
  TcmsNichtVerfuegbar,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import type { TcmsDienst } from '@/server/tcms/aktion';
import type { PortalAblageKontext } from '@/server/tcms/portal/anlagen';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const m = vi.hoisted(() => ({
  ablegen: null as
    | null
    | ((g: PortalAblageKontext, datei: File, schluessel: string | null) => Promise<unknown>),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
// Nur die Dokumentenpipeline (Virenscan, Object Store) entfällt; gebunden wird echt.
vi.mock('@/server/tcms/portal/anlagen', () => ({
  portalAnlageAblegen: (g: PortalAblageKontext, datei: File, schluessel: string | null) =>
    m.ablegen!(g, datei, schluessel),
}));

import { withTenantContext } from '@taxtronik/db/tenant-context';
import { decryptSecret, SECRET_SLOTS, secretSlotContext } from '@/server/crypto/secret-box';
import { meldungsAnlageVerknuepfenTx } from '../durchfuehrung/verweis';
import { meldungErfassen } from '../portal/meldung';
import {
  meldevorgangBeanspruchen,
  offeneMeldevorgaengeTx,
  offeneMeldungenKlaeren,
  ungeklaerteMeldungsAnlagenTx,
} from '../portal/meldevorgang';

const enabled = process.env.TCMS_BEREICH_D_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_BEREICH_D_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const INHALT = {
  typ: 'T-01',
  titel: 'Start auf Kaufland.de',
  beschreibung: 'Ab Dezember verkaufen wir zusätzlich über Kaufland.de.',
  datum: '2026-12-01',
  zusageAenderungen: true,
  benachrichtigen: null,
};

type Verhalten = 'ok' | 'transport-nach-anlage' | Error;

/** JSON mit sortierten Schlüsseln wie der Inhalts-Hash des Tax-CMS (`kanonisch`). */
function kanonisch(wert: unknown): string {
  if (Array.isArray(wert)) return `[${wert.map(kanonisch).join(',')}]`;
  if (wert !== null && typeof wert === 'object') {
    const o = wert as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(wert);
}

/** Attrappe des Tax-CMS mit dessen Idempotenz je Person, Mandant und Schlüssel. */
class TaxCmsAttrappe {
  readonly ereignisse = new Map<string, { id: string; nummer: string; inhalt: string }>();
  readonly gesendet: Array<Record<string, unknown>> = [];
  plan: Verhalten[] = [];
  private n = 0;

  readonly dienst = {
    rufe: vi.fn(async (e: { name: string }, eingabe?: { body?: Record<string, unknown> }) => {
      if (e.name !== 'portalMeldungErfassen') throw new Error(`unerwartet: ${e.name}`);
      const body = eingabe!.body!;
      this.gesendet.push(body);
      const verhalten = this.plan.shift() ?? 'ok';
      if (verhalten instanceof Error) throw verhalten;
      const { idempotenzSchluessel, ...inhalt } = body;
      const schluessel = String(idempotenzSchluessel);
      let ev = this.ereignisse.get(schluessel);
      if (ev && ev.inhalt !== kanonisch(inhalt)) {
        throw new TcmsKonflikt({
          status: 409,
          code: 'KONFLIKT',
          konflikt: 'IDEMPOTENZ_ABWEICHUNG',
        });
      }
      if (!ev) {
        this.n += 1;
        ev = {
          id: `cmvfmeldung${this.n}aaaaaaaaaa`,
          nummer: `2026-T-0${400 + this.n}`,
          inhalt: kanonisch(inhalt),
        };
        this.ereignisse.set(schluessel, ev);
      }
      // Antwort nach erfolgreicher Anlage verloren (Verbindungsabbruch).
      if (verhalten === 'transport-nach-anlage') throw new TcmsNichtVerfuegbar('TRANSPORT');
      return { daten: { id: ev.id, nummer: ev.nummer }, requestId: 'r' };
    }),
  };

  get als(): TcmsDienst {
    return this.dienst as unknown as TcmsDienst;
  }
}

(enabled ? describe : describe.skip)('Idempotente Portal-Meldung gegen PostgreSQL', () => {
  let owner!: PrismaClient;
  let tenantId = '';
  let mandant = '';
  let kontakt = '';
  let kontakt2 = '';
  let typ = '';
  let admin = '';

  const ctxFuer = (k: string): TenantContext => ({
    tenantId,
    actorId: k,
    actorType: 'CLIENT_CONTACT',
  });
  const ablageFuer = (k: string): PortalAblageKontext => ({
    ctx: ctxFuer(k),
    tenantId,
    contactId: k,
    clientId: mandant,
  });
  const bezug = (k: string) => ({ tenantId, mandantId: mandant, kontaktId: k });

  async function dokument(titel: string) {
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId: mandant,
        title: titel,
        classification: 'GENERAL',
        documentTypeId: typ,
        mimeType: 'text/csv',
        sharedWithClientAt: new Date(),
      },
    });
    const sha = Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex');
    await owner.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/${doc.id}.csv`,
        sha256: sha,
        sizeBytes: 812n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: admin,
      },
    });
    return { id: doc.id, sha: sha.toString('hex') };
  }

  async function anlagen(schluessel: string) {
    return owner.tcmsDocumentReference.findMany({
      where: { tenantId, tcmsReportKey: schluessel },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function vorgang(k: string, schluessel: string) {
    return owner.tcmsPortalReport.findFirst({
      where: { tenantId, contactId: k, idempotencyKey: schluessel },
    });
  }

  const datei = (name: string) => new File(['a;b\n1;2\n'], name, { type: 'text/csv' });

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({
        data: { slug: `tcms-meldevorgang-${randomUUID()}`, name: 'TCMS Meldevorgang' },
      })
    ).id;
    admin = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `meldevorgang-${randomUUID()}@example.test`,
          fullName: 'Ada Admin',
          passwordHash: 'synthetic',
          roles: { create: [{ role: 'ADMIN' }] },
        },
      })
    ).id;
    mandant = (
      await owner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Talwind Outdoor GmbH', allowActive: false },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: mandant,
      verifiedBy: admin,
      registerNumber: `HRB-MELDEVORGANG-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: mandant }, data: { allowActive: true } });
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
  });

  const kontaktAnlegen = async (name: string) =>
    (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: mandant,
          email: `${randomUUID()}@example.test`,
          fullName: name,
        },
      })
    ).id;

  beforeEach(async () => {
    // Je Test eigene Personen: Eine Klärung erfasst alle Vorgänge der Person.
    kontakt = await kontaktAnlegen('Jana Weller');
    kontakt2 = await kontaktAnlegen('Murat Demir');
    m.ablegen = vi.fn(async (g: PortalAblageKontext, d: File, schluessel: string | null) => {
      const doc = await dokument(d.name);
      const verknuepfungId = await withTenantContext(g.ctx, (tx) =>
        meldungsAnlageVerknuepfenTx(
          tx,
          { tenantId: g.tenantId, mandantId: g.clientId, kontaktId: g.contactId },
          doc.id,
          schluessel,
        ),
      );
      return {
        verweis: {
          dokumentId: doc.id,
          dateiname: d.name,
          mime: 'text/csv',
          groesse: 812,
          sha256: doc.sha,
        },
        verknuepfungId,
      };
    });
  });

  afterAll(async () => {
    await owner?.$disconnect();
  });

  it('Transportfehler nach erfolgreicher Anlage: das erneute Absenden liefert dasselbe Ereignis, Bindung abgeschlossen', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    const eingabe = { schluessel, dateien: [datei('a.csv'), datei('b.csv')], inhalt: INHALT };

    expect(await meldungErfassen(tcms.als, ablageFuer(kontakt), eingabe)).toEqual({ art: 'offen' });
    // Im Dienst angelegt, Antwort verloren: Anlagen gebunden ohne Ereignis-ID.
    expect(tcms.ereignisse.size).toBe(1);
    let refs = await anlagen(schluessel);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => [r.tcmsEventId, r.releasedAt, r.tcmsSubject])).toEqual([
      [null, null, 'EVENT'],
      [null, null, 'EVENT'],
    ]);
    // Zur Wiederholung: Inhalt nur verschlüsselt, an Tenant und Zeile gebunden.
    const v = await vorgang(kontakt, schluessel);
    expect(v).toMatchObject({ attempts: 1, leaseUntil: null });
    expect(v!.sentAt).toBeInstanceOf(Date);
    expect(v!.payloadEnc).toMatch(/^v3:/);
    expect(v!.payloadEnc).not.toContain('Kaufland');
    const klar = JSON.parse(
      decryptSecret(
        v!.payloadEnc!,
        secretSlotContext(SECRET_SLOTS.tcmsPortalReportPayload, { tenantId, rowId: v!.id }),
      ),
    );
    expect(klar).toEqual({ ...INHALT, anlagen: tcms.gesendet[0]!['anlagen'] });
    expect(klar).not.toHaveProperty('idempotenzSchluessel');
    // Noch in Klärung: keine ungeklärte Anlage für die Kanzlei.
    expect(
      await withTenantContext(ctxFuer(kontakt), (tx) =>
        ungeklaerteMeldungsAnlagenTx(tx, { tenantId, mandantIds: [mandant] }),
      ),
    ).toEqual([]);

    // Zweiter Versuch: dasselbe Formular (gleicher Schlüssel, Dateien erneut gesendet).
    const r = await meldungErfassen(tcms.als, ablageFuer(kontakt), eingabe);
    const ereignis = tcms.ereignisse.get(schluessel)!;
    expect(r).toEqual({ art: 'angenommen', nummer: ereignis.nummer, wiederholung: true });
    expect(tcms.ereignisse.size).toBe(1);
    expect(tcms.gesendet).toHaveLength(2);
    // Derselbe Inhalt, Wert für Wert (die Reihenfolge der Schlüssel zählt im Dienst nicht).
    expect(tcms.gesendet[1]).toEqual(tcms.gesendet[0]);
    expect(tcms.gesendet[1]!['idempotenzSchluessel']).toBe(schluessel);
    // Keine zweite Ablage: die Dateien des zweiten Absendens werden nicht gespeichert.
    expect(m.ablegen).toHaveBeenCalledTimes(2);
    refs = await anlagen(schluessel);
    expect(refs.map((x) => [x.tcmsEventId, x.releasedAt])).toEqual([
      [ereignis.id, null],
      [ereignis.id, null],
    ]);
    // Mit der Klärung ist der Inhalt gelöscht.
    expect(await vorgang(kontakt, schluessel)).toBeNull();
  });

  it('der Inhalt ist an seine Zeile gebunden: in eine andere Zeile kopiert, ist er nicht lesbar', async () => {
    const tcms = new TaxCmsAttrappe();
    const [a, b] = [randomUUID(), randomUUID()];
    tcms.plan = ['transport-nach-anlage', 'transport-nach-anlage'];
    for (const schluessel of [a, b]) {
      await meldungErfassen(tcms.als, ablageFuer(kontakt), {
        schluessel,
        dateien: [],
        inhalt: { ...INHALT, titel: `${INHALT.titel} ${schluessel.slice(0, 4)}` },
      });
    }
    const [va, vb] = [await vorgang(kontakt, a), await vorgang(kontakt, b)];
    await owner.tcmsPortalReport.update({
      where: { id: vb!.id },
      data: { payloadEnc: va!.payloadEnc },
    });
    tcms.dienst.rufe.mockClear();
    // Nicht entschlüsselbar: kein Versuch mit fremdem Inhalt, der Vorgang bleibt offen.
    expect(await meldevorgangBeanspruchen(ctxFuer(kontakt), bezug(kontakt), b)).toEqual({
      art: 'laeuft',
    });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
    expect(await vorgang(kontakt, b)).toMatchObject({ payloadEnc: va!.payloadEnc });
  });

  it('Klärung beim nächsten Öffnen: Wiederholung mit gespeichertem Inhalt, dasselbe Ereignis', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = [new TcmsNichtVerfuegbar('ZEITLIMIT')];
    await meldungErfassen(tcms.als, ablageFuer(kontakt), {
      schluessel,
      dateien: [datei('plan.csv')],
      inhalt: INHALT,
    });
    // Zeitlimit vor der Anlage: im Dienst nichts angelegt.
    expect(tcms.ereignisse.size).toBe(0);
    const offen = await withTenantContext(ctxFuer(kontakt), (tx) =>
      offeneMeldevorgaengeTx(tx, bezug(kontakt)),
    );
    expect(offen).toEqual([expect.objectContaining({ versuche: 1, anlagen: 1, faellig: true })]);
    const k = await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt));
    const ereignis = tcms.ereignisse.get(schluessel)!;
    expect(k).toEqual({ angenommen: [ereignis.nummer], aufgeloest: 0, offen: 0, ungeklaert: 0 });
    expect((await anlagen(schluessel)).map((x) => x.tcmsEventId)).toEqual([ereignis.id]);
    expect(await vorgang(kontakt, schluessel)).toBeNull();
    // Zweite Klärung: nichts mehr zu tun, kein Dienstaufruf.
    tcms.dienst.rufe.mockClear();
    expect(await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt))).toEqual({
      angenommen: [],
      aufgeloest: 0,
      offen: 0,
      ungeklaert: 0,
    });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
  });

  it('eine Ablehnung der Wiederholung klärt nichts: Anlagen gebunden, Vorgang offen', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    await meldungErfassen(tcms.als, ablageFuer(kontakt), {
      schluessel,
      dateien: [datei('a.csv')],
      inhalt: INHALT,
    });
    for (const fehler of [
      new TcmsNichtBerechtigt({ status: 403, verweigerung: 'PORTAL_ROLLE' }),
      new TcmsUngueltig({ datum: ['x'] }, { status: 400 }),
      new TcmsKonflikt({ status: 409, konflikt: 'ZWISCHENZEITLICH_GEAENDERT' }),
    ]) {
      tcms.plan = [fehler];
      const k = await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt));
      expect(k, fehler.name).toMatchObject({ angenommen: [], offen: 1 });
    }
    const refs = await anlagen(schluessel);
    expect(refs.map((x) => [x.tcmsEventId, x.releasedAt])).toEqual([[null, null]]);
    expect(await vorgang(kontakt, schluessel)).toMatchObject({ attempts: 4 });
  });

  it('erster Versuch eindeutig abgelehnt: Anlagen frei („nicht angehängt“), Vorgang gelöscht', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    const fehler = new TcmsUngueltig({ titel: ['x'] }, { status: 400 });
    tcms.plan = [fehler];
    await expect(
      meldungErfassen(tcms.als, ablageFuer(kontakt), {
        schluessel,
        dateien: [datei('a.csv'), datei('b.csv')],
        inhalt: INHALT,
      }),
    ).rejects.toBe(fehler);
    const refs = await anlagen(schluessel);
    expect(refs.map((x) => [x.releaseReason, x.releasedBy])).toEqual([
      ['NOT_ATTACHED', kontakt],
      ['NOT_ATTACHED', kontakt],
    ]);
    expect(await vorgang(kontakt, schluessel)).toBeNull();
  });

  it('IDEMPOTENZ_ABWEICHUNG: Vorgang samt Inhalt gelöscht, Anlagen gebunden und für die Kanzlei ungeklärt', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    await meldungErfassen(tcms.als, ablageFuer(kontakt), {
      schluessel,
      dateien: [datei('abweichend.csv')],
      inhalt: INHALT,
    });
    // Im Dienst steht unter diesem Schlüssel ein anderer Inhalt.
    tcms.ereignisse.get(schluessel)!.inhalt = '{"anders":true}';
    const k = await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt));
    expect(k).toMatchObject({ angenommen: [], ungeklaert: 1, offen: 0 });
    expect(await vorgang(kontakt, schluessel)).toBeNull();
    const [ref] = await anlagen(schluessel);
    expect(ref).toMatchObject({ tcmsEventId: null, releasedAt: null });
    const ungeklaert = await withTenantContext(
      { tenantId, actorId: admin, actorType: 'STAFF' },
      (tx) => ungeklaerteMeldungsAnlagenTx(tx, { tenantId, mandantIds: [mandant] }),
    );
    expect(ungeklaert).toContainEqual(
      expect.objectContaining({
        verknuepfungId: ref!.id,
        titel: 'abweichend.csv',
        kontaktId: kontakt,
        mandantId: mandant,
      }),
    );
  });

  it('nach Ablauf des Fensters: keine Wiederholung, nie frei – ungeklärte Anlage', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    await meldungErfassen(tcms.als, ablageFuer(kontakt), {
      schluessel,
      dateien: [datei('alt.csv')],
      inhalt: INHALT,
    });
    const v = await vorgang(kontakt, schluessel);
    // Echte Zeit 23 h und eine Minute nach dem ersten Senden (der Sendezeitpunkt
    // selbst ist per Guard unveränderlich).
    const spaeter = new Date(v!.sentAt!.getTime() + 23 * 3_600_000 + 60_000);
    tcms.dienst.rufe.mockClear();
    expect(
      await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt), spaeter),
    ).toEqual({ angenommen: [], aufgeloest: 0, offen: 0, ungeklaert: 0 });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
    expect(
      await meldevorgangBeanspruchen(ctxFuer(kontakt), bezug(kontakt), schluessel, spaeter),
    ).toEqual({ art: 'abgelaufen' });
    expect(
      await withTenantContext(ctxFuer(kontakt), (tx) =>
        offeneMeldevorgaengeTx(tx, bezug(kontakt), spaeter),
      ),
    ).toEqual([]);
    const [ref] = await anlagen(schluessel);
    expect(ref).toMatchObject({ tcmsEventId: null, releasedAt: null });
    const staff = { tenantId, actorId: admin, actorType: 'STAFF' as const };
    const ungeklaertAm = async (jetzt?: Date) =>
      (
        await withTenantContext(staff, (tx) =>
          ungeklaerteMeldungsAnlagenTx(tx, { tenantId, mandantIds: [mandant] }, jetzt),
        )
      ).map((a) => a.verknuepfungId);
    // Vor Ablauf noch in Klärung, danach ungeklärt – nie frei.
    expect(await ungeklaertAm()).not.toContain(ref!.id);
    expect(await ungeklaertAm(spaeter)).toContain(ref!.id);
  });

  it('nie gesendet (Abbruch vor dem Senden, Lease abgelaufen): die Klärung gibt die Anlagen frei', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    const neu = await meldevorgangBeanspruchen(ctxFuer(kontakt), bezug(kontakt), schluessel);
    expect(neu).toMatchObject({ art: 'neu', schluessel });
    await m.ablegen!(ablageFuer(kontakt), datei('nie.csv'), schluessel);
    // Läuft die Lease noch, gilt der Vorgang als in Arbeit.
    expect(await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt))).toMatchObject({
      aufgeloest: 0,
    });
    await owner.tcmsPortalReport.updateMany({
      where: { tenantId, idempotencyKey: schluessel },
      data: { leaseUntil: new Date(Date.now() - 1_000) },
    });
    const k = await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt));
    expect(k).toMatchObject({ aufgeloest: 1 });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
    expect((await anlagen(schluessel)).map((x) => x.releaseReason)).toEqual(['NOT_ATTACHED']);
    expect(await vorgang(kontakt, schluessel)).toBeNull();
  });

  it('nur die eigene Person: andere Kontakte sehen und wiederholen den Vorgang nicht', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    await meldungErfassen(tcms.als, ablageFuer(kontakt), {
      schluessel,
      dateien: [datei('eigen.csv')],
      inhalt: INHALT,
    });
    const andere = await withTenantContext(ctxFuer(kontakt2), (tx) =>
      offeneMeldevorgaengeTx(tx, bezug(kontakt2)),
    );
    expect(andere).toEqual([]);
    tcms.dienst.rufe.mockClear();
    expect(await offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt2), bezug(kontakt2))).toEqual({
      angenommen: [],
      aufgeloest: 0,
      offen: 0,
      ungeklaert: 0,
    });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
    // Derselbe Schlüssel einer anderen Person ist ein eigener, neuer Vorgang.
    expect(
      await meldevorgangBeanspruchen(ctxFuer(kontakt2), bezug(kontakt2), schluessel),
    ).toMatchObject({ art: 'neu' });
    expect(await vorgang(kontakt, schluessel)).toMatchObject({ attempts: 1 });
  });
});
