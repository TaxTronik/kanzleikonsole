// =============================================================================
// Red-Team kk-tcms-rt3c (TCMS stage 3): Angriffe auf die idempotente
// Portal-Meldung (kk-tcms-s10nach) gegen echtes PostgreSQL, App-Rolle unter RLS.
//
// RT3C-K-01 (Lease-Grenzfall, s10nach offener Punkt 5): `faelligeBeanspruchen`
// (offeneMeldungenKlaeren) liest die Kandidaten mit `findMany`, beansprucht sie
// danach aber nur über `{ id, frei }` – ohne `sent_at`/Inhalt erneut zu prüfen,
// anders als `meldevorgangBeanspruchen`, das im Nie-gesendet-Zweig `sent_at IS
// NULL` in das bedingte Löschen aufnimmt. Wird ein noch nicht gesendeter
// Vorgang zwischen `findMany` und dem Beanspruchen gesendet (lange Ablage, die
// Lease ist bereits abgelaufen), gilt er wegen des veralteten `payloadEnc`
// (null) weiter als „nie gesendet“ und die Klärung gibt seine Anlagen frei –
// obwohl das Tax-CMS die Meldung erhalten (und das Ereignis angelegt haben)
// kann. Damit wird ein gebundener Nachweis eines existierenden Ereignisses
// freigegeben (TCMS-NACHWEIS-001 verletzt). Der s10nach-Bericht hatte „eine
// falsche Freigabe entsteht nicht“ behauptet.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/redteam-meldevorgang-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext } from '@taxtronik/db';
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
vi.mock('@/server/tcms/portal/anlagen', () => ({
  portalAnlageAblegen: (g: PortalAblageKontext, datei: File, schluessel: string | null) =>
    m.ablegen!(g, datei, schluessel),
}));

import { withTenantContext } from '@taxtronik/db/tenant-context';
import { encryptSecret, SECRET_SLOTS, secretSlotContext } from '@/server/crypto/secret-box';
import { meldungsAnlageVerknuepfenTx } from '../durchfuehrung/verweis';
import { meldevorgangBeanspruchen, offeneMeldungenKlaeren } from '../portal/meldevorgang';

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

/** Der Dienst darf im Freigabe-Zweig gar nicht gerufen werden (Klärung hält ihn für „nie gesendet“). */
class TaxCmsAttrappe {
  readonly dienst = {
    rufe: vi.fn(async () => {
      throw new Error('Dienst unerwartet gerufen');
    }),
  };
  get als(): TcmsDienst {
    return this.dienst as unknown as TcmsDienst;
  }
}

(enabled ? describe : describe.skip)('RT3C: idempotente Portal-Meldung – Angriffe', () => {
  let owner!: PrismaClient;
  let tenantId = '';
  let mandant = '';
  let kontakt = '';
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
        data: { slug: `rt3c-meldevorgang-${randomUUID()}`, name: 'RT3C Meldevorgang' },
      })
    ).id;
    admin = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `rt3c-${randomUUID()}@example.test`,
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
      registerNumber: `HRB-RT3C-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: mandant }, data: { allowActive: true } });
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
  });

  beforeEach(async () => {
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

  it('RT3C-K-01: Wettlauf Ablage/Klärung – ein gesendeter Vorgang darf nicht als „nie gesendet“ freigegeben werden', async () => {
    const tcms = new TaxCmsAttrappe();
    const schluessel = randomUUID();

    // Vorgang angelegt (noch nicht gesendet, Lease läuft), Anlage gebunden –
    // die Ablage dauert länger als die Lease von 10 Minuten.
    const neu = await meldevorgangBeanspruchen(ctxFuer(kontakt), bezug(kontakt), schluessel);
    expect(neu).toMatchObject({ art: 'neu', schluessel });
    const v = await vorgang(kontakt, schluessel);
    await m.ablegen!(ablageFuer(kontakt), datei('nachweis.csv'), schluessel);
    // Lease abgelaufen (lange Ablage).
    await owner.tcmsPortalReport.updateMany({
      where: { id: v!.id },
      data: { leaseUntil: new Date(Date.now() - 60_000) },
    });

    // Der Inhalt, den `meldevorgangGesendet` unmittelbar vor dem Dienstaufruf
    // speichert (gültiges Secret-Box-v3-Format; Inhalt egal, der Freigabe-Zweig
    // entschlüsselt nie).
    const payloadEnc = encryptSecret(
      JSON.stringify({ ...INHALT, anlagen: [] }),
      secretSlotContext(SECRET_SLOTS.tcmsPortalReportPayload, { tenantId, rowId: v!.id }),
    );

    // Eine gehaltene Transaktion simuliert das nebenläufige „Senden“: Sie setzt
    // sent_at + payload_enc, hält aber die Zeilensperre, bis die Klärung ihr
    // bedingtes Update absetzt. So liest `findMany` der Klärung noch
    // payload_enc = NULL (nie gesendet), während das anschließende Beanspruchen
    // erst nach dem Commit greift – genau der Grenzfall der langen Ablage.
    let commitSend!: () => void;
    const sendDarfCommitten = new Promise<void>((r) => (commitSend = r));
    let sperreGesetzt!: () => void;
    const sperreBereit = new Promise<void>((r) => (sperreGesetzt = r));

    const sendTx = owner
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE tcms_portal_report
               SET sent_at = now(), payload_enc = ${payloadEnc}
             WHERE id = ${v!.id}::uuid`;
          sperreGesetzt();
          await sendDarfCommitten;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .catch((e: unknown) => {
        throw e;
      });

    await sperreBereit; // sent_at/payload gesetzt, Zeile gesperrt, noch nicht committet.

    // Klärung starten: findMany sieht die committete Fassung (nie gesendet),
    // das Beanspruchen blockiert an der Zeilensperre.
    const klarPromise = offeneMeldungenKlaeren(tcms.als, ctxFuer(kontakt), bezug(kontakt));
    await new Promise((r) => setTimeout(r, 400)); // Zeit für findMany + blockierendes Update.
    commitSend(); // „Senden“ committet → Zeile ist jetzt gesendet.
    await sendTx;
    const k = await klarPromise;

    // Der Dienst wurde im Freigabe-Zweig nie gerufen (Klärung hielt ihn für nie gesendet).
    expect(tcms.dienst.rufe).not.toHaveBeenCalled();

    // Sicherheitsannahme (TCMS-NACHWEIS-001): Ein gesendeter Vorgang darf nicht
    // als „nie gesendet“ aufgelöst werden; seine Anlage bleibt gebunden.
    const refs = await anlagen(schluessel);
    expect(refs.map((r) => r.releaseReason)).toEqual([null]);
    expect(refs.map((r) => r.releasedAt)).toEqual([null]);
    expect(k.aufgeloest).toBe(0);
  });
});
