// =============================================================================
// kk-tcms-s11 Punkt 3 (TCMS stage 3): Ungeklärte Anlage einer Portal-Meldung
// ohne Ereignis freigeben – gegen echtes PostgreSQL (App-Rolle, RLS) und einen
// lokalen HTTP-Server auf TCMS_URL, der die Rolle des Dienstes spielt (auch
// bösartig). Echt: Server-Action samt Gate, Akteursabbildung, signierter
// Transport, Vertragsprüfung der Antwort, Freigabe und Audit. Ersetzt: nur die
// Request-Authentisierung, next/cache und das Log. Datenbank-Ablehnungen nur
// über @taxtronik/db/testing/db-fehler.
//
// Geprüfte Schutzziele (TCMS-NACHWEIS-001; Produktentscheidung Rey Koxha,
// 21.10.2026):
//   - Freigegeben wird nur, wenn der Dienst zur Dokument-ID dieser Anlage eine
//     LEERE Liste liefert (jeder Eintrag zählt, auch an verworfenen
//     Ereignissen) und die Antwort genau diese Dokument-ID trägt; jede andere
//     Antwort, jeder Protokoll- und Transportfehler lässt sie gesperrt.
//   - Nur Admin/Partner, Mandant aus dem gebundenen Argument; eine Anlage eines
//     anderen Mandanten wird weder gefunden noch erfragt noch freigegeben.
//   - Kein Freigeben, solange ein Meldevorgang die Anlage noch klären kann
//     (im Fenster plus Lease, laufende Lease, nie gesendet).
//   - Wettlauf mit der Zuordnung: genau einer gewinnt; das Audit entsteht nur
//     bei einer wirksamen Freigabe, mit Begründung und Vorgangsnummer.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/redteam-anlage-freigeben-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ staff: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => m.staff }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import type { PrismaClient, TenantContext } from '@taxtronik/db';
import { dbAbgewiesen } from '../../../../../../packages/db/src/testing/db-fehler';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const enabled = process.env.TCMS_BEREICH_D_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_BEREICH_D_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

// Kalter Import der Aktion und Helfer dauert unter Last länger als das Standardlimit.
vi.setConfig({ testTimeout: 30_000 });

const EREIGNIS = 'cmvfereignisfreigabeaaaaaa';
const BEGRUENDUNG = 'Kein Ereignis im Tax-CMS führt diese Anlage; Meldung nie eingegangen.';
const STUNDE = 3_600_000;
/** Gültiges Format der Secret-Box (CHECK), Inhalt beliebig – wird hier nie gelesen. */
const PAYLOAD = `v3:${'0'.repeat(16)}:${'A'.repeat(16)}:${'A'.repeat(22)}==:QUJD`;

interface Antwort {
  status?: number;
  body: unknown;
}

(enabled ? describe : describe.skip)('Ungeklärte Anlage freigeben (kk-tcms-s11)', () => {
  let owner!: PrismaClient;
  let server!: Server;
  /** Antwort des Dienstes je Anfrage (setzt jeder Test; darf vorher etwas tun). */
  let antwort: (req: IncomingMessage) => Antwort | Promise<Antwort> = () => ({
    status: 500,
    body: {},
  });
  const anfragen: string[] = [];
  let tenantId = '';
  let admin = '';
  let mitarbeiter = '';
  let mandantA = '';
  let mandantB = '';
  let kontaktA = '';
  let kontaktB = '';
  let typ = '';

  const inEinerStunde = () => new Date(Date.now() + STUNDE).toISOString();
  const alsStaff = (staffId: string, roles: string[]) => {
    m.staff = {
      user: {
        id: staffId,
        email: `${staffId}@example.test`,
        name: 'Person',
        fullName: 'Person',
        tenantId,
        staffId,
        roles,
        permissions: [],
      },
      expires: inEinerStunde(),
    };
  };
  const staffCtx = (): TenantContext => ({ tenantId, actorId: admin, actorType: 'STAFF' });
  const ok = (daten: unknown): Antwort => ({ body: { ok: true, daten } });
  const leer = (dokumentId: string) => ok({ dokumentId, anlagen: [] });

  async function aktiverMandant(name: string) {
    const clientId = (
      await owner.client.create({ data: { tenantId, kind: 'JURPERS', name, allowActive: false } })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId,
      verifiedBy: admin,
      registerNumber: `HRB-S11-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    return clientId;
  }

  /**
   * Gebundene, ungeklärte EVENT-Anlage. `vorgang`: Meldevorgang zum Schlüssel –
   * `null` (gelöscht bzw. nie vorhanden), sonst Sendezeitpunkt vor so vielen
   * Millisekunden (`gesendetVor`, null = nie gesendet) und Lease.
   */
  async function ungeklaerteAnlage(
    mandant = mandantA,
    vorgang: { gesendetVor: number | null; leaseBis?: Date } | null = null,
  ) {
    const kontakt = mandant === mandantA ? kontaktA : kontaktB;
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId: mandant,
        title: 'Kassenbericht.pdf',
        classification: 'GENERAL',
        documentTypeId: typ,
        mimeType: 'application/pdf',
        sharedWithClientAt: new Date(),
      },
    });
    const sha = Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex');
    await owner.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/${doc.id}.pdf`,
        sha256: sha,
        sizeBytes: 812n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: admin,
      },
    });
    const schluessel = randomUUID();
    const { withTenantContext } = await import('@taxtronik/db/tenant-context');
    const { meldungsAnlageVerknuepfenTx } = await import('../durchfuehrung/verweis');
    const verknuepfungId = await withTenantContext(
      { tenantId, actorId: kontakt, actorType: 'CLIENT_CONTACT' },
      (tx) =>
        meldungsAnlageVerknuepfenTx(
          tx,
          { tenantId, mandantId: mandant, kontaktId: kontakt },
          doc.id,
          schluessel,
        ),
    );
    if (vorgang) {
      const v = await owner.tcmsPortalReport.create({
        data: { tenantId, clientId: mandant, contactId: kontakt, idempotencyKey: schluessel },
      });
      await owner.tcmsPortalReport.update({
        where: { id: v.id },
        data: {
          ...(vorgang.gesendetVor === null
            ? {}
            : { sentAt: new Date(Date.now() - vorgang.gesendetVor), payloadEnc: PAYLOAD }),
          // Lease nur mit Besitzer-Token (CHECK tcms_portal_report_lease_check).
          leaseUntil: vorgang.leaseBis ?? null,
          leaseToken: vorgang.leaseBis ? randomUUID() : null,
        },
      });
    }
    return { dokumentId: doc.id, verknuepfungId };
  }

  const zeile = (id: string) => owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id } });
  const audits = (verknuepfungId: string) =>
    owner.auditLog.findMany({
      where: { tenantId, action: 'tcms.anlage.freigegeben', resourceId: verknuepfungId },
    });

  async function freigeben(
    verknuepfungId: string,
    o: { mandant?: string; begruendung?: string } = {},
  ) {
    const { ungeklaerteAnlageFreigebenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/ereignisse/actions');
    const fd = new FormData();
    fd.set('begruendung', o.begruendung ?? BEGRUENDUNG);
    // Versuch, Mandant und Verknüpfung über das Formular zu überschreiben.
    fd.set('mandantId', mandantB);
    fd.set('verknuepfungId', randomUUID());
    return (await ungeklaerteAnlageFreigebenAction(
      o.mandant ?? mandantA,
      verknuepfungId,
      null,
      fd,
    )) as { ok: boolean; error?: string; meldung?: string; errorCode?: string };
  }

  async function texte() {
    return import('@/components/tcms/ereignisse/anlage-texte');
  }

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    server = createServer((req, res) => {
      anfragen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        void Promise.resolve(antwort(req)).then((a) => {
          res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(a.body));
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    process.env.TCMS_DEPLOYMENT = 'external';
    process.env.TCMS_URL = `http://127.0.0.1:${port}`;
    process.env.TCMS_SERVICE_TOKEN = randomBytes(32).toString('base64url');
    process.env.TCMS_ACTOR_KEY_ID = 'kk-s11';
    process.env.TCMS_ACTOR_PRIVATE_KEY = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');

    tenantId = (
      await owner.tenant.create({
        data: { slug: `tcms-s11-freigabe-${randomUUID()}`, name: 'S11 Freigabe' },
      })
    ).id;
    const person = async (name: string, role: 'ADMIN' | 'EMPLOYEE') =>
      (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: `${randomUUID()}@example.test`,
            fullName: name,
            passwordHash: 'synthetic',
            isProfessional: role === 'ADMIN',
            roles: { create: { role } },
          },
        })
      ).id;
    admin = await person('Anna Roth', 'ADMIN');
    mitarbeiter = await person('Leon Brandt', 'EMPLOYEE');
    mandantA = await aktiverMandant('Talwind Outdoor GmbH');
    mandantB = await aktiverMandant('Seestern GmbH');
    const kontakt = async (clientId: string, name: string) =>
      (
        await owner.clientContact.create({
          data: { tenantId, clientId, email: `${randomUUID()}@example.test`, fullName: name },
        })
      ).id;
    kontaktA = await kontakt(mandantA, 'Jana Weller');
    kontaktB = await kontakt(mandantB, 'Murat Kaya');
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
    await owner.tenantSetting.create({ data: { tenantId, key: 'modules', value: { tcms: true } } });
  }, 60_000);

  beforeEach(() => {
    anfragen.length = 0;
    alsStaff(admin, ['ADMIN']);
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
    await owner?.$disconnect();
  });

  it('S11-F-01: leere Liste zur Dokument-ID → freigegeben (NOT_ATTACHED, handelnde Person), Audit mit Begründung und Vorgangsnummer', async () => {
    const t = await texte();
    const a = await ungeklaerteAnlage();
    // Die Antwort darf die ID in anderer Schreibweise tragen (Vergleich ohne Groß/klein).
    antwort = () => leer(a.dokumentId.toUpperCase());
    const r = await freigeben(a.verknuepfungId);
    expect(r).toMatchObject({ ok: true, meldung: t.ANLAGE_FREIGEGEBEN });
    // Genau eine Anfrage: Mandant aus dem gebundenen Argument, Dokument-ID der Anlage.
    expect(anfragen).toEqual([
      `GET /v1/mandanten/${mandantA}/ereignis-anlagen?dokumentId=${a.dokumentId}`,
    ]);
    const z = await zeile(a.verknuepfungId);
    expect(z).toMatchObject({
      releasedBy: admin,
      releaseReason: 'NOT_ATTACHED',
      tcmsEventId: null,
    });
    expect(z.releasedAt).toBeInstanceOf(Date);
    const eintraege = await audits(a.verknuepfungId);
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]).toMatchObject({
      actorType: 'STAFF',
      actorId: admin,
      resourceType: 'tcms_document_reference',
    });
    expect(eintraege[0]!.after).toMatchObject({
      clientId: mandantA,
      documentId: a.dokumentId,
      releaseReason: 'NOT_ATTACHED',
      begruendung: BEGRUENDUNG,
      tcmsPruefung: { endpunkt: 'ereignisAnlagenJeDokumentLesen', anlagen: 0 },
    });
    // Eine zweite Freigabe findet die Anlage nicht mehr (keine zweite Anfrage, kein zweites Audit).
    anfragen.length = 0;
    expect(await freigeben(a.verknuepfungId)).toMatchObject({
      ok: false,
      error: t.ANLAGE_NICHT_OFFEN,
    });
    expect(anfragen).toEqual([]);
    expect(await audits(a.verknuepfungId)).toHaveLength(1);
    // Endgültig: eine spätere Zuordnung greift nicht, die Datenbank weist sie ab.
    const { ungeklaerteAnlageZuordnen } = await import('../portal/meldevorgang');
    expect(
      await ungeklaerteAnlageZuordnen(staffCtx(), {
        tenantId,
        mandantId: mandantA,
        verknuepfungId: a.verknuepfungId,
        ereignisId: EREIGNIS,
      }),
    ).toBe(false);
    const { withTenantContext } = await import('@taxtronik/db/tenant-context');
    await dbAbgewiesen(
      withTenantContext(
        staffCtx(),
        (tx) =>
          tx.$executeRaw`UPDATE tcms_document_reference SET tcms_event_id = ${EREIGNIS} WHERE id = ${a.verknuepfungId}::uuid`,
      ),
      { meldung: 'die Ereignis-ID wird nur einmal gesetzt', sqlState: '23514' },
    );
  });

  it('S11-F-02: Dienst nennt eine Ereignis-Anlage (auch verworfen bzw. entfernt) → gesperrt, nur „zuordnen“', async () => {
    const t = await texte();
    for (const status of ['VERWORFEN', 'ERLEDIGT', 'NEU'] as const) {
      for (const entfernt of [false, true]) {
        const a = await ungeklaerteAnlage();
        antwort = () =>
          ok({
            dokumentId: a.dokumentId,
            anlagen: [
              {
                ereignisId: EREIGNIS,
                nummer: '2026-T-0001',
                status,
                sha256: 'ab'.repeat(32),
                entfernt,
              },
            ],
          });
        const r = await freigeben(a.verknuepfungId);
        expect(r, `${status}/${entfernt}`).toMatchObject({
          ok: false,
          error: t.ANLAGE_IM_EREIGNIS,
        });
        expect(await zeile(a.verknuepfungId)).toMatchObject({
          releasedAt: null,
          tcmsEventId: null,
        });
        expect(await audits(a.verknuepfungId)).toHaveLength(0);
      }
    }
  });

  it('S11-F-03: bösartiger Dienst – leere Liste zu einem anderen Dokument (auch des anderen Mandanten) → gesperrt', async () => {
    const t = await texte();
    const a = await ungeklaerteAnlage();
    const fremd = await ungeklaerteAnlage(mandantB);
    for (const dokumentId of [fremd.dokumentId, randomUUID()]) {
      antwort = () => leer(dokumentId);
      const r = await freigeben(a.verknuepfungId);
      expect(r).toMatchObject({ ok: false, error: t.ANLAGE_NICHT_BESTAETIGT });
    }
    expect(await zeile(a.verknuepfungId)).toMatchObject({ releasedAt: null });
    expect(await zeile(fremd.verknuepfungId)).toMatchObject({ releasedAt: null });
    expect(await audits(a.verknuepfungId)).toHaveLength(0);
  });

  it('S11-F-04: Anlage eines anderen Mandanten bzw. unbekannte Verknüpfung → nicht offen, keine Anfrage an den Dienst', async () => {
    const t = await texte();
    const fremd = await ungeklaerteAnlage(mandantB);
    antwort = () => leer(fremd.dokumentId);
    // Aktion für Mandant A mit der Verknüpfung von Mandant B.
    expect(await freigeben(fremd.verknuepfungId)).toMatchObject({
      ok: false,
      error: t.ANLAGE_NICHT_OFFEN,
    });
    expect(await freigeben(randomUUID())).toMatchObject({ ok: false, error: t.ANLAGE_NICHT_OFFEN });
    expect(anfragen).toEqual([]);
    expect(await zeile(fremd.verknuepfungId)).toMatchObject({ releasedAt: null });
    // Auch die Freigabe-Funktion selbst ist an den Mandanten gebunden.
    const { ungeklaerteAnlageFreigeben } = await import('../portal/meldevorgang');
    expect(
      await ungeklaerteAnlageFreigeben(staffCtx(), {
        tenantId,
        mandantId: mandantA,
        verknuepfungId: fremd.verknuepfungId,
        dokumentId: fremd.dokumentId,
        begruendung: BEGRUENDUNG,
        requestId: null,
      }),
    ).toEqual({ art: 'nichtOffen' });
    expect(await zeile(fremd.verknuepfungId)).toMatchObject({ releasedAt: null });
  });

  it('S11-F-05: nur Admin/Partner; Pflichtbegründung – ohne beides keine Anfrage, keine Freigabe', async () => {
    const a = await ungeklaerteAnlage();
    antwort = () => leer(a.dokumentId);
    alsStaff(mitarbeiter, ['EMPLOYEE']);
    expect(await freigeben(a.verknuepfungId)).toMatchObject({ ok: false });
    alsStaff(admin, ['ADMIN']);
    for (const begruendung of [
      '',
      'zu kurz',
      `Begründung mit Steuerzeichen \u202e${'x'.repeat(20)}`,
    ]) {
      expect(await freigeben(a.verknuepfungId, { begruendung }), begruendung).toMatchObject({
        ok: false,
      });
    }
    expect(anfragen).toEqual([]);
    expect(await zeile(a.verknuepfungId)).toMatchObject({ releasedAt: null });
  });

  it('S11-F-06: Meldevorgang kann noch klären (Fenster plus Lease, laufende Lease, nie gesendet) → in Klärung, keine Anfrage', async () => {
    const t = await texte();
    const { ungeklaerteAnlageFreigeben } = await import('../portal/meldevorgang');
    const inKlaerung = [
      await ungeklaerteAnlage(mandantA, { gesendetVor: STUNDE }),
      // Nach dem Fenster (23 h), aber vor Fenster plus Lease des Absendens (23 h 10 min).
      await ungeklaerteAnlage(mandantA, { gesendetVor: 23 * STUNDE + 5 * 60_000 }),
      await ungeklaerteAnlage(mandantA, {
        gesendetVor: 30 * STUNDE,
        leaseBis: new Date(Date.now() + 60_000),
      }),
      await ungeklaerteAnlage(mandantA, { gesendetVor: null }),
    ];
    for (const a of inKlaerung) {
      antwort = () => leer(a.dokumentId);
      expect(await freigeben(a.verknuepfungId)).toMatchObject({
        ok: false,
        error: t.ANLAGE_IN_KLAERUNG,
      });
      expect(await zeile(a.verknuepfungId)).toMatchObject({ releasedAt: null });
      // Auch die Freigabe selbst prüft erneut (nicht nur die Vorprüfung der Aktion).
      expect(
        await ungeklaerteAnlageFreigeben(staffCtx(), {
          tenantId,
          mandantId: mandantA,
          verknuepfungId: a.verknuepfungId,
          dokumentId: a.dokumentId,
          begruendung: BEGRUENDUNG,
          requestId: null,
        }),
      ).toEqual({ art: 'inKlaerung' });
      expect(await zeile(a.verknuepfungId)).toMatchObject({ releasedAt: null });
    }
    expect(anfragen).toEqual([]);
    // Vorgang nach Fenster plus Lease, Lease frei (abgelaufen): freigegeben.
    const spaet = await ungeklaerteAnlage(mandantA, {
      gesendetVor: 23 * STUNDE + 11 * 60_000,
      leaseBis: new Date(Date.now() - 60_000),
    });
    antwort = () => leer(spaet.dokumentId);
    expect(await freigeben(spaet.verknuepfungId)).toMatchObject({ ok: true });
    expect((await zeile(spaet.verknuepfungId)).releasedAt).toBeInstanceOf(Date);
  });

  it('S11-F-07: Wettlauf – Zuordnung zwischen Prüfung des Dienstes und Freigabe gewinnt; kein Audit', async () => {
    const t = await texte();
    const a = await ungeklaerteAnlage();
    const { ungeklaerteAnlageZuordnen } = await import('../portal/meldevorgang');
    antwort = async () => {
      // Während der Dienst antwortet, ordnet eine andere Person die Anlage zu.
      expect(
        await ungeklaerteAnlageZuordnen(staffCtx(), {
          tenantId,
          mandantId: mandantA,
          verknuepfungId: a.verknuepfungId,
          ereignisId: EREIGNIS,
        }),
      ).toBe(true);
      return leer(a.dokumentId);
    };
    expect(await freigeben(a.verknuepfungId)).toMatchObject({
      ok: false,
      error: t.ANLAGE_NICHT_OFFEN,
    });
    expect(await zeile(a.verknuepfungId)).toMatchObject({
      releasedAt: null,
      tcmsEventId: EREIGNIS,
    });
    expect(await audits(a.verknuepfungId)).toHaveLength(0);
  });

  it('S11-F-08: Wettlauf unter der Zeilensperre – genau einer gewinnt, in beiden Richtungen', async () => {
    const { ungeklaerteAnlageFreigeben, ungeklaerteAnlageZuordnen } =
      await import('../portal/meldevorgang');
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const freigabe = (a: { verknuepfungId: string; dokumentId: string }) =>
      ungeklaerteAnlageFreigeben(staffCtx(), {
        tenantId,
        mandantId: mandantA,
        verknuepfungId: a.verknuepfungId,
        dokumentId: a.dokumentId,
        begruendung: BEGRUENDUNG,
        requestId: 'r-1',
      });

    // (1) Zuordnung hält die Zeile (offene Transaktion), die Freigabe wartet und verliert.
    const a = await ungeklaerteAnlage();
    const zuordnung = owner.$transaction(async (tx) => {
      await tx.tcmsDocumentReference.update({
        where: { id: a.verknuepfungId },
        data: { tcmsEventId: EREIGNIS },
      });
      await pause(400);
    });
    await pause(100);
    const [, f] = await Promise.all([zuordnung, freigabe(a)]);
    expect(f).toEqual({ art: 'nichtOffen' });
    expect(await zeile(a.verknuepfungId)).toMatchObject({
      releasedAt: null,
      tcmsEventId: EREIGNIS,
    });
    expect(await audits(a.verknuepfungId)).toHaveLength(0);

    // (2) Freigabe hält die Zeile, die Zuordnung wartet und verliert.
    const b = await ungeklaerteAnlage();
    const halten = owner.$transaction(async (tx) => {
      await tx.tcmsDocumentReference.update({
        where: { id: b.verknuepfungId },
        data: { releasedAt: new Date(), releasedBy: admin, releaseReason: 'NOT_ATTACHED' },
      });
      await pause(400);
    });
    await pause(100);
    const [, z] = await Promise.all([
      halten,
      ungeklaerteAnlageZuordnen(staffCtx(), {
        tenantId,
        mandantId: mandantA,
        verknuepfungId: b.verknuepfungId,
        ereignisId: EREIGNIS,
      }),
    ]);
    expect(z).toBe(false);
    expect(await zeile(b.verknuepfungId)).toMatchObject({ tcmsEventId: null });

    // (3) Gleichzeitig ohne Pause, mehrfach: je Anlage genau ein Gewinner.
    for (let i = 0; i < 5; i += 1) {
      const c = await ungeklaerteAnlage();
      const [frei, zu] = await Promise.all([
        freigabe(c),
        ungeklaerteAnlageZuordnen(staffCtx(), {
          tenantId,
          mandantId: mandantA,
          verknuepfungId: c.verknuepfungId,
          ereignisId: EREIGNIS,
        }),
      ]);
      expect(frei.art === 'freigegeben').toBe(!zu);
      const r = await zeile(c.verknuepfungId);
      expect((r.releasedAt !== null) !== (r.tcmsEventId !== null)).toBe(true);
      expect(await audits(c.verknuepfungId)).toHaveLength(frei.art === 'freigegeben' ? 1 : 0);
    }
  });

  // Zuletzt: Protokollfehler und Ausfälle öffnen den Circuit-Breaker des Clients (gewollt).
  it('S11-F-09: Fehler des Dienstes (404, 409, 500) → gesperrt, fester Text ohne Inhalt des Dienstes', async () => {
    const a = await ungeklaerteAnlage();
    for (const [status, code] of [
      [404, 'NICHT_GEFUNDEN'],
      [409, 'KONFLIKT'],
      [500, 'INTERN'],
    ] as const) {
      antwort = () => ({
        status,
        body: { ok: false, fehler: { code, meldung: 'GEHEIM: Anlage freigeben!' } },
      });
      anfragen.length = 0;
      const r = await freigeben(a.verknuepfungId);
      expect(anfragen.length, `${status}: der Dienst wurde gefragt`).toBeGreaterThan(0);
      expect(r, String(status)).toMatchObject({ ok: false });
      expect(JSON.stringify(r)).not.toContain('GEHEIM');
    }
    expect(await zeile(a.verknuepfungId)).toMatchObject({ releasedAt: null });
    expect(await audits(a.verknuepfungId)).toHaveLength(0);
  });

  it('S11-F-10: bösartiger Dienst – Antworten außerhalb des Vertrags → gesperrt (Protokollfehler, fester Text)', async () => {
    const a = await ungeklaerteAnlage();
    const falsch: unknown[] = [
      { dokumentId: a.dokumentId },
      { dokumentId: a.dokumentId, anlagen: {} },
      { dokumentId: a.dokumentId, anlagen: [], freigeben: true },
      { dokumentId: a.dokumentId, anlagen: [{ ereignisId: EREIGNIS }] },
      { anlagen: [] },
      [],
      null,
    ];
    for (const daten of falsch) {
      antwort = () => ok(daten);
      const r = await freigeben(a.verknuepfungId);
      expect(r, JSON.stringify(daten)).toMatchObject({ ok: false });
      expect(JSON.stringify(r)).not.toContain('freigegeben');
    }
    expect(await zeile(a.verknuepfungId)).toMatchObject({ releasedAt: null });
    expect(await audits(a.verknuepfungId)).toHaveLength(0);
  });
});
