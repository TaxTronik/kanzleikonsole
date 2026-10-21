// =============================================================================
// kk-tcms-fix4 (RT3C-K-01 und zweites Fenster derselben Klasse): Wettläufe der
// idempotenten Portal-Meldung gegen echtes PostgreSQL (App-Rolle unter RLS,
// Tenant-Kontext des Kontakts). Taktgeber sind Zeilensperren einer gehaltenen
// Owner-Transaktion (wie im Angriffstest redteam-meldevorgang-db): Wer an der
// Sperre wartet, steht in der Warteschlange der Zeile (Tupelsperre in
// pg_locks), die Reihenfolge der Wartenden ist die der Ankunft. Wo kein
// Datenbankzugriff zu takten ist (Dienstaufruf, Ablage), hält ein Tor.
//
// Schutzbedingungen (jede durch eine Mutation belegt, Bericht kk-tcms-fix4):
//   S1  Klärung beansprucht „nie gesendet“ nur mit `sent_at IS NULL` in der
//       Bedingung (ein inzwischen gesendeter Vorgang bleibt unberührt).
//   S2  Als gesendet markiert nur der Besitzer der Lease (Token): nach fremder
//       Beanspruchung scheitert das Markieren, es wird nicht gesendet; die
//       eigenen Anlagen werden freigegeben.
//   S3  „Nie gesendet“ gibt nur frei, wenn das bedingte Löschen mit
//       `sent_at IS NULL` in derselben Transaktion trifft.
//   S4  Das Ersetzen eines nie gesendeten Vorgangs (erneutes Absenden) löscht
//       nur ungesendet.
//   S5  „Erster Versuch eindeutig abgelehnt“ gibt nur in eigener Lease frei.
//   S6  „Offen“ und „ungeklärt“ greifen nur in eigener Lease.
//   S7  Die Annahme setzt die Ereignis-ID nur, solange genau ihr Vorgang
//       besteht.
//   S8  Ein Schlüssel mit offenen Anlagen eines gesendeten, gelöschten
//       Vorgangs beginnt keinen neuen Vorgang.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/meldevorgang-wettlauf-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext } from '@taxtronik/db';
import { TcmsKonflikt, TcmsNichtVerfuegbar } from '@taxtronik/tcms-client';
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
import { encryptSecret, SECRET_SLOTS, secretSlotContext } from '@/server/crypto/secret-box';
import { meldungsAnlageVerknuepfenTx } from '../durchfuehrung/verweis';
import { meldungErfassen } from '../portal/meldung';
import {
  meldevorgangAbschliessen,
  meldevorgangBeanspruchen,
  offeneMeldungenKlaeren,
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

/** Später als jede Lease eines gerade begonnenen Absendens (10 min). */
const NACH_ABLAUF = () => new Date(Date.now() + 11 * 60_000);

interface Tor {
  /** Wer am Tor ankommt, meldet sich und wartet. */
  passieren(): Promise<void>;
  erreicht: Promise<void>;
  oeffnen(): void;
}

function tor(): Tor {
  let melden!: () => void;
  let oeffnen!: () => void;
  const erreicht = new Promise<void>((r) => (melden = r));
  const offen = new Promise<void>((r) => (oeffnen = r));
  return {
    erreicht,
    oeffnen,
    async passieren() {
      melden();
      await offen;
    },
  };
}

type Verhalten = 'ok' | 'transport-nach-anlage' | Error | { tor: Tor; dann: Verhalten };

/** JSON mit sortierten Schlüsseln wie der Inhalts-Hash des Tax-CMS. */
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

/** Tax-CMS-Attrappe mit dessen Idempotenz (je Schlüssel ein Ereignis); Verhalten je Aufruf. */
class TaxCmsAttrappe {
  readonly ereignisse = new Map<string, { id: string; nummer: string; inhalt: string }>();
  plan: Verhalten[] = [];
  private n = 0;

  readonly dienst = {
    rufe: vi.fn(async (e: { name: string }, eingabe?: { body?: Record<string, unknown> }) => {
      if (e.name !== 'portalMeldungErfassen') throw new Error(`unerwartet: ${e.name}`);
      let verhalten = this.plan.shift() ?? 'ok';
      if (typeof verhalten === 'object' && 'tor' in verhalten) {
        await verhalten.tor.passieren();
        verhalten = verhalten.dann;
      }
      if (verhalten instanceof Error) throw verhalten;
      const { idempotenzSchluessel, ...inhalt } = eingabe!.body!;
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
          id: `cmvfwettlauf${this.n}aaaaaaaaa`,
          nummer: `2026-T-0${500 + this.n}`,
          inhalt: kanonisch(inhalt),
        };
        this.ereignisse.set(schluessel, ev);
      }
      if (verhalten === 'transport-nach-anlage') throw new TcmsNichtVerfuegbar('TRANSPORT');
      return { daten: { id: ev.id, nummer: ev.nummer }, requestId: 'r' };
    }),
  };

  get als(): TcmsDienst {
    return this.dienst as unknown as TcmsDienst;
  }
}

(enabled ? describe : describe.skip)('Meldevorgang: Wettläufe und Lease-Besitz (RT3C-K-01)', () => {
  let owner!: PrismaClient;
  let tenantId = '';
  let mandant = '';
  let kontakt = '';
  let typ = '';
  let admin = '';
  /** Tor nach dem Binden der nächsten Anlage (Absender pausiert vor dem Markieren). */
  let nachAblage: Tor | null = null;
  /** Nächste Ablage scheitert (Virenscan). */
  let ablageScheitert = false;

  const ctx = (): TenantContext => ({ tenantId, actorId: kontakt, actorType: 'CLIENT_CONTACT' });
  const ablage = (): PortalAblageKontext => ({
    ctx: ctx(),
    tenantId,
    contactId: kontakt,
    clientId: mandant,
  });
  const bezug = () => ({ tenantId, mandantId: mandant, kontaktId: kontakt });
  const datei = (name: string) => new File(['a;b\n1;2\n'], name, { type: 'text/csv' });
  const eingabe = (schluessel: string, ...namen: string[]) => ({
    schluessel,
    dateien: namen.map(datei),
    inhalt: INHALT,
  });

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

  const anlagen = (schluessel: string) =>
    owner.tcmsDocumentReference.findMany({
      where: { tenantId, tcmsReportKey: schluessel },
      orderBy: { createdAt: 'asc' },
    });
  const vorgang = (schluessel: string) =>
    owner.tcmsPortalReport.findFirst({
      where: { tenantId, contactId: kontakt, idempotencyKey: schluessel },
    });
  const zustand = async (schluessel: string) =>
    (await anlagen(schluessel)).map((r) => [r.tcmsEventId, r.releaseReason]);

  /** Tupelsperren auf `tabelle` in dieser Datenbank: gehalten = vorderster Wartender, wartend = dahinter. */
  async function tupelsperren(tabelle: 'tcms_portal_report' | 'tcms_document_reference') {
    const [z] = await owner.$queryRaw<Array<{ gehalten: number; wartend: number }>>`
      SELECT count(*) FILTER (WHERE l.granted)::int AS gehalten,
             count(*) FILTER (WHERE NOT l.granted)::int AS wartend
        FROM pg_catalog.pg_locks l
       WHERE l.locktype = 'tuple'
         AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
         AND l.relation = ${`public.${tabelle}`}::regclass`;
    return z!;
  }

  async function bis(bedingung: () => Promise<boolean>, was: string) {
    const ende = Date.now() + 10_000;
    while (!(await bedingung())) {
      if (Date.now() > ende) throw new Error(`Zeitüberschreitung: ${was}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Owner-Transaktion, die `sql` (Sperre, ggf. Änderung) ausführt und bis
   * `freigeben()` offen hält. `bereit` = Sperre gesetzt.
   */
  function gehalten(sql: (tx: PrismaClient) => Promise<unknown>) {
    let freigeben!: () => void;
    const darfCommitten = new Promise<void>((r) => (freigeben = r));
    let gesetzt!: () => void;
    const bereit = new Promise<void>((r) => (gesetzt = r));
    const fertig = owner.$transaction(
      async (tx) => {
        await sql(tx as unknown as PrismaClient);
        gesetzt();
        await darfCommitten;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    return { bereit, freigeben, fertig };
  }

  const zeileSperren = (id: string) =>
    gehalten(
      (tx) => tx.$queryRaw`SELECT 1 FROM tcms_portal_report WHERE id = ${id}::uuid FOR UPDATE`,
    );

  /** Gültiger Secret-Box-Inhalt der Zeile (wie `meldevorgangGesendet` ihn speichert). */
  const inhaltFuer = (id: string) =>
    encryptSecret(
      JSON.stringify({ ...INHALT, anlagen: [] }),
      secretSlotContext(SECRET_SLOTS.tcmsPortalReportPayload, { tenantId, rowId: id }),
    );

  /** Senden einer Altinstanz ohne Lease-Besitz (nur `sent_at IS NULL`), unter der gehaltenen Sperre. */
  const fremdGesendet = (id: string) =>
    gehalten(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM tcms_portal_report WHERE id = ${id}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        UPDATE tcms_portal_report SET sent_at = now(), payload_enc = ${inhaltFuer(id)}
         WHERE id = ${id}::uuid AND sent_at IS NULL`;
    });

  /** Neuer Vorgang mit einer gebundenen Anlage, noch nicht gesendet. */
  async function ungesendet(schluessel: string, name: string) {
    const neu = await meldevorgangBeanspruchen(ctx(), bezug(), schluessel);
    if (neu.art !== 'neu') throw new Error(`erwartet neu, war ${neu.art}`);
    await m.ablegen!(ablage(), datei(name), schluessel);
    return neu;
  }

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({
        data: { slug: `tcms-wettlauf-${randomUUID()}`, name: 'TCMS Wettlauf' },
      })
    ).id;
    admin = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `wettlauf-${randomUUID()}@example.test`,
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
      registerNumber: `HRB-WETTLAUF-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: mandant }, data: { allowActive: true } });
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
  });

  beforeEach(async () => {
    // Je Test eine eigene Person: Eine Klärung erfasst alle Vorgänge der Person.
    kontakt = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: mandant,
          email: `${randomUUID()}@example.test`,
          fullName: 'Jana Weller',
        },
      })
    ).id;
    nachAblage = null;
    ablageScheitert = false;
    m.ablegen = vi.fn(async (g: PortalAblageKontext, d: File, schluessel: string | null) => {
      if (ablageScheitert) throw new Error('Virenscan');
      const doc = await dokument(d.name);
      const verknuepfungId = await withTenantContext(g.ctx, (tx) =>
        meldungsAnlageVerknuepfenTx(
          tx,
          { tenantId: g.tenantId, mandantId: g.clientId, kontaktId: g.contactId },
          doc.id,
          schluessel,
        ),
      );
      const t = nachAblage;
      nachAblage = null;
      if (t) await t.passieren();
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

  it('S1 (RT3C-K-01): die Klärung beansprucht keinen Vorgang, der zwischen Lesen und Beanspruchen gesendet wurde', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    const neu = await ungesendet(schluessel, 'nachweis.csv');
    const vorher = await vorgang(schluessel);

    // Senden unter gehaltener Sperre (Lease bleibt abgelaufen aus Sicht der Klärung).
    const senden = fremdGesendet(neu.id);
    await senden.bereit;
    const klaerung = offeneMeldungenKlaeren(tcms.als, ctx(), bezug(), NACH_ABLAUF());
    await bis(
      async () => (await tupelsperren('tcms_portal_report')).gehalten === 1,
      'Klärung wartet',
    );
    senden.freigeben();
    await senden.fertig;

    expect(await klaerung).toEqual({ angenommen: [], aufgeloest: 0, offen: 0, ungeklaert: 0 });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
    // Nicht beansprucht: Lease und Besitz unverändert, Anlage gebunden.
    const nachher = await vorgang(schluessel);
    expect(nachher!.sentAt).toBeInstanceOf(Date);
    expect([nachher!.leaseToken, nachher!.leaseUntil]).toEqual([
      vorher!.leaseToken,
      vorher!.leaseUntil,
    ]);
    expect(await zustand(schluessel)).toEqual([[null, null]]);
  });

  it('S2, Reihenfolge 1: Klärung beansprucht zuerst – der Absender markiert nicht, sendet nicht; frei, weil wirklich nie gesendet', async () => {
    const tcms = new TaxCmsAttrappe();
    // Älterer, nie gesendeter Vorgang A derselben Person: Seine Freigabe hält
    // die Klärung an (gesperrte Anlage), nachdem sie A und B beansprucht hat.
    const schluesselA = randomUUID();
    await ungesendet(schluesselA, 'a.csv');
    const [anlageA] = await anlagen(schluesselA);
    const anlageASperre = gehalten(
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM tcms_document_reference WHERE id = ${anlageA!.id}::uuid FOR UPDATE`,
    );
    await anlageASperre.bereit;

    // Absender B pausiert nach der Ablage (vor dem Markieren).
    const schluesselB = randomUUID();
    nachAblage = tor();
    const pause = nachAblage;
    const absenden = meldungErfassen(tcms.als, ablage(), eingabe(schluesselB, 'b.csv'));
    await pause.erreicht;
    const tokenAbsender = (await vorgang(schluesselB))!.leaseToken;

    // Lease des Absenders abgelaufen: Die Klärung beansprucht A und B und hält
    // an der Freigabe von A.
    const klaerung = offeneMeldungenKlaeren(tcms.als, ctx(), bezug(), NACH_ABLAUF());
    await bis(
      async () =>
        (await vorgang(schluesselB))!.leaseToken !== tokenAbsender &&
        (await tupelsperren('tcms_document_reference')).gehalten === 1,
      'Klärung hat B beansprucht und wartet an A',
    );

    // Der Absender markiert nach der fremden Beanspruchung: scheitert, kein Senden.
    pause.oeffnen();
    expect(await absenden).toEqual({ art: 'laeuft' });
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();
    const b = await vorgang(schluesselB);
    expect(b).toMatchObject({ sentAt: null, payloadEnc: null });
    expect(b!.leaseToken).not.toBe(tokenAbsender);
    // Die eigenen Anlagen gab der Absender schon frei (gesendet hat sie niemand).
    expect(await zustand(schluesselB)).toEqual([[null, 'NOT_ATTACHED']]);

    anlageASperre.freigeben();
    await anlageASperre.fertig;
    expect(await klaerung).toEqual({ angenommen: [], aufgeloest: 2, offen: 0, ungeklaert: 0 });
    expect(await zustand(schluesselA)).toEqual([[null, 'NOT_ATTACHED']]);
    expect(await zustand(schluesselB)).toEqual([[null, 'NOT_ATTACHED']]);
    expect([await vorgang(schluesselA), await vorgang(schluesselB)]).toEqual([null, null]);
    expect(tcms.ereignisse.size).toBe(0);
  });

  it('S2, Reihenfolge 2: der Absender markiert zuerst – die Klärung beansprucht nicht, einmal gesendet, Ereignis-ID an der Anlage', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    nachAblage = tor();
    const pause = nachAblage;
    const absenden = meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'b.csv'));
    await pause.erreicht;
    const { id } = (await vorgang(schluessel))!;

    const sperre = zeileSperren(id);
    await sperre.bereit;
    pause.oeffnen(); // Markieren wartet als Erstes an der Zeile.
    await bis(
      async () => (await tupelsperren('tcms_portal_report')).gehalten === 1,
      'Absender wartet',
    );
    const klaerung = offeneMeldungenKlaeren(tcms.als, ctx(), bezug(), NACH_ABLAUF());
    await bis(
      async () => (await tupelsperren('tcms_portal_report')).wartend === 1,
      'Klärung wartet dahinter',
    );
    sperre.freigeben();
    await sperre.fertig;

    expect(await klaerung).toEqual({ angenommen: [], aufgeloest: 0, offen: 0, ungeklaert: 0 });
    const ereignis = tcms.ereignisse.get(schluessel)!;
    expect(await absenden).toEqual({
      art: 'angenommen',
      nummer: ereignis.nummer,
      wiederholung: false,
    });
    expect(tcms.dienst.rufe).toHaveBeenCalledTimes(1);
    expect(await zustand(schluessel)).toEqual([[ereignis.id, null]]);
    expect(await vorgang(schluessel)).toBeNull();
  });

  it('S3: „nie gesendet“ gibt nicht frei, wenn die Zeile vor dem bedingten Löschen gesendet wurde (Altinstanz ohne Lease-Besitz)', async () => {
    const schluessel = randomUUID();
    const neu = await ungesendet(schluessel, 'nachweis.csv');

    const senden = fremdGesendet(neu.id);
    await senden.bereit;
    const aufloesen = meldevorgangAbschliessen(ctx(), bezug(), neu, { art: 'nieGesendet' });
    await bis(
      async () => (await tupelsperren('tcms_portal_report')).gehalten === 1,
      'Auflösen wartet',
    );
    senden.freigeben();
    await senden.fertig;

    expect(await aufloesen).toEqual({ wirksam: false, anlagen: 0 });
    expect(await zustand(schluessel)).toEqual([[null, null]]);
    expect((await vorgang(schluessel))!.sentAt).toBeInstanceOf(Date);
  });

  it('S4: erneutes Absenden desselben Formulars ersetzt einen Vorgang nicht, den sein Besitzer gerade markiert', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    nachAblage = tor();
    const pause = nachAblage;
    const absenden = meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'a.csv'));
    await pause.erreicht;
    const { id } = (await vorgang(schluessel))!;

    const sperre = zeileSperren(id);
    await sperre.bereit;
    pause.oeffnen();
    await bis(
      async () => (await tupelsperren('tcms_portal_report')).gehalten === 1,
      'Absender wartet',
    );
    // Zweites Absenden (anderer Tab) nach Ablauf der ersten Lease.
    const erneut = meldevorgangBeanspruchen(ctx(), bezug(), schluessel, NACH_ABLAUF());
    await bis(
      async () => (await tupelsperren('tcms_portal_report')).wartend === 1,
      'Ersetzen wartet dahinter',
    );
    sperre.freigeben();
    await sperre.fertig;

    expect(await erneut).toEqual({ art: 'laeuft' });
    const ereignis = tcms.ereignisse.get(schluessel)!;
    expect(await absenden).toEqual({
      art: 'angenommen',
      nummer: ereignis.nummer,
      wiederholung: false,
    });
    expect(await zustand(schluessel)).toEqual([[ereignis.id, null]]);
  });

  it('S5: erster Versuch eindeutig abgelehnt, nachdem eine Wiederholung der Klärung das Ereignis angelegt haben kann – keine Freigabe', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    const breaker = new TcmsNichtVerfuegbar('BREAKER');
    const ersterAufruf = tor();
    // Erster Aufruf (Absender) hängt und scheitert dann am offenen Breaker
    // (nie gesendet); die Wiederholung der Klärung legt an, Antwort verloren.
    tcms.plan = [{ tor: ersterAufruf, dann: breaker }, 'transport-nach-anlage'];
    const absenden = meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'a.csv'));
    await ersterAufruf.erreicht;

    // Lease des ersten Aufrufs (2 min) abgelaufen: Die Klärung übernimmt.
    const k = await offeneMeldungenKlaeren(
      tcms.als,
      ctx(),
      bezug(),
      new Date(Date.now() + 3 * 60_000),
    );
    expect(k).toEqual({ angenommen: [], aufgeloest: 0, offen: 1, ungeklaert: 0 });
    expect(tcms.ereignisse.size).toBe(1);

    ersterAufruf.oeffnen();
    await expect(absenden).rejects.toBe(breaker);
    // Das Ereignis existiert: Anlage gebunden, Vorgang bleibt zur Wiederholung.
    expect(await zustand(schluessel)).toEqual([[null, null]]);
    expect(await vorgang(schluessel)).toMatchObject({ attempts: 1, leaseUntil: null });

    // Die nächste Klärung schließt mit demselben Ereignis ab.
    const ereignis = tcms.ereignisse.get(schluessel)!;
    expect(await offeneMeldungenKlaeren(tcms.als, ctx(), bezug())).toMatchObject({
      angenommen: [ereignis.nummer],
    });
    expect(await zustand(schluessel)).toEqual([[ereignis.id, null]]);
  });

  it('S6: ein Versuch mit verlorener Lease führt nichts nach (offen, ungeklärt, abgelehnt, nie gesendet)', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    expect(await meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'a.csv'))).toEqual({
      art: 'offen',
    });
    // Ein anderer Versuch beansprucht (Wiederholung desselben Absendens).
    const w = await meldevorgangBeanspruchen(ctx(), bezug(), schluessel);
    expect(w).toMatchObject({ art: 'wiederholung' });
    const besitz = await vorgang(schluessel);
    const verloren = { id: besitz!.id, schluessel, token: randomUUID() };

    for (const art of ['offen', 'ungeklaert', 'abgelehnt'] as const) {
      expect(await meldevorgangAbschliessen(ctx(), bezug(), verloren, { art }), art).toEqual({
        wirksam: false,
        anlagen: 0,
      });
      expect(await vorgang(schluessel), art).toEqual(besitz);
    }
    expect(await zustand(schluessel)).toEqual([[null, null]]);

    // Nie gesendet, nach fremder Beanspruchung (Token gewechselt).
    const schluessel2 = randomUUID();
    const neu = await ungesendet(schluessel2, 'b.csv');
    await owner.tcmsPortalReport.update({
      where: { id: neu.id },
      data: { leaseToken: randomUUID() },
    });
    const fremd = await vorgang(schluessel2);
    expect(await meldevorgangAbschliessen(ctx(), bezug(), neu, { art: 'nieGesendet' })).toEqual({
      wirksam: false,
      anlagen: 0,
    });
    expect(await vorgang(schluessel2)).toEqual(fremd);
    expect(await zustand(schluessel2)).toEqual([[null, null]]);
    // Der Besitzer führt nach.
    if (w.art !== 'wiederholung') throw new Error('erwartet Wiederholung');
    expect(await meldevorgangAbschliessen(ctx(), bezug(), w, { art: 'offen' })).toEqual({
      wirksam: true,
      anlagen: 0,
    });
    expect(await vorgang(schluessel)).toMatchObject({
      attempts: 2,
      leaseUntil: null,
      leaseToken: null,
    });
    expect(await zustand(schluessel)).toEqual([[null, null]]);
  });

  it('S7: eine späte Annahme ordnet keine Anlagen eines späteren Vorgangs desselben Schlüssels zu', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    await meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'a.csv'));
    const erster = await vorgang(schluessel);
    // Die Klärung schließt den ersten Vorgang ab (Ereignis-ID an a.csv).
    const ereignis = tcms.ereignisse.get(schluessel)!;
    expect(await offeneMeldungenKlaeren(tcms.als, ctx(), bezug())).toMatchObject({
      angenommen: [ereignis.nummer],
    });
    // Dasselbe Formular beginnt einen neuen Vorgang (keine offenen Anlagen mehr).
    await ungesendet(schluessel, 'b.csv');

    // Die Antwort des ersten Versuchs kommt spät.
    expect(
      await meldevorgangAbschliessen(
        ctx(),
        bezug(),
        { id: erster!.id, schluessel, token: erster!.leaseToken ?? randomUUID() },
        { art: 'angenommen', ereignisId: ereignis.id },
      ),
    ).toEqual({ wirksam: false, anlagen: 0 });
    expect(await zustand(schluessel)).toEqual([
      [ereignis.id, null],
      [null, null],
    ]);
  });

  it('S8: ein Schlüssel mit offenen Anlagen eines gesendeten, gelöschten Vorgangs beginnt keinen neuen Vorgang', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();
    tcms.plan = ['transport-nach-anlage'];
    await meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'a.csv'));
    // Fenster abgelaufen: Der Worker hat den Vorgang gelöscht, die Anlage bleibt gebunden.
    await owner.tcmsPortalReport.deleteMany({ where: { tenantId, idempotencyKey: schluessel } });

    // Dasselbe Formular erneut; scheiterte jetzt die Ablage, gäbe ein neuer
    // Vorgang alle Anlagen des Schlüssels als „nie gesendet“ frei.
    ablageScheitert = true;
    expect(await meldungErfassen(tcms.als, ablage(), eingabe(schluessel, 'b.csv'))).toEqual({
      art: 'abgelaufen',
    });
    expect(await vorgang(schluessel)).toBeNull();
    expect(await zustand(schluessel)).toEqual([[null, null]]);
    expect(m.ablegen).toHaveBeenCalledTimes(1);
  });
});
