// =============================================================================
// Red Team kk-tcms-redteam3b (TCMS Stufe 3): ausgeführte Angriffe eines
// BÖSARTIGEN Dienstes auf die Web-Seite der kanzleikonsole. Ein lokaler
// HTTP-Server steht auf TCMS_URL und liefert schemanahe, aber feindliche
// Antworten; geprüft werden die echten Route-Handler der Dokumentabrufe
// (Nachweis Kanzlei, Ereignis-Anlage Kanzlei, Anlage Portal), der Abgleich
// offener Nachweis-Verknüpfungen und die Anzeige von Dateinamen des Dienstes.
//
// Echt: Routen, Seiten-Helfer, Akteursabbildung, Dokumentauslieferung samt
// Abrufnachweis, PostgreSQL (App-Rolle, RLS), signierter Transport des
// Clients. Ersetzt: Request-Authentisierung, next/cache, next/navigation, das
// Log und nur das Lesen der Bytes aus dem Object Store
// (`streamVerifiedObject`, protokolliert) – Header und Typ baut die echte
// Auslieferung.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/redteam-boeser-dienst-db.test.tsx
// Fachkatalog: TCMS-NACHWEIS-001, TCMS-DIENST-001
// =============================================================================
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staff: null as unknown,
  portal: null as unknown,
  /** Gelesene Objekte (Object Store). */
  gelesen: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => m.staff }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => m.portal }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (ziel: string) => {
    throw new Error(`NEXT_REDIRECT:${ziel}`);
  },
}));
vi.mock('@taxtronik/storage', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  streamVerifiedObject: vi.fn(async (quelle: { key: string }) => {
    m.gelesen.push(quelle.key);
    return { body: 'BYTES', contentType: 'text/html', contentLength: 5 };
  }),
}));

import { NextRequest } from 'next/server';
import type { PrismaClient } from '@taxtronik/db';
import { renderServerMarkup } from '@/__tests__/render-helpers';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const DID = 'cmvfboese00000000000001';
const GEHEIM = 'STUB-GEHEIMTEXT';
const RLO = '\u202e';

interface Antwort {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
  roh?: boolean;
}

(enabled ? describe : describe.skip)(
  'Red Team: bösartiger Dienst gegen Abrufe, Abgleich und Anzeige',
  () => {
    let owner!: PrismaClient;
    let server!: Server;
    /** Antwort des Dienstes je Anfrage (setzt jeder Test). */
    let antwort: (req: IncomingMessage) => Antwort = () => ({ status: 500, body: {} });
    const anfragen: string[] = [];
    let tenantId = '';
    let anna = '';
    let leon = '';
    let mandantA = '';
    let mandantB = '';
    let jana = '';
    let typ = '';

    const inEinerStunde = () => new Date(Date.now() + 3_600_000).toISOString();
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
    const alsJana = () => {
      m.portal = {
        user: {
          id: jana,
          email: 'jana@talwind.example',
          name: 'Jana Weller',
          fullName: 'Jana Weller',
          tenantId,
          contactId: jana,
          clientId: mandantA,
          sessionIssuedAt: 0,
          sessionOriginContactId: jana,
        },
        expires: inEinerStunde(),
      };
    };

    async function aktiverMandant(name: string) {
      const clientId = (
        await owner.client.create({ data: { tenantId, kind: 'JURPERS', name, allowActive: false } })
      ).id;
      await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId,
        clientId,
        verifiedBy: anna,
        registerNumber: `HRB-RT3B-${randomUUID()}`,
      });
      await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
      return clientId;
    }

    async function dokument(
      clientId: string,
      byte: number,
      o: { titel?: string; geteilt?: boolean; lohn?: boolean } = {},
    ) {
      const doc = await owner.document.create({
        data: {
          tenantId,
          clientId,
          title: o.titel ?? `Kontoabstimmung ${byte}`,
          classification: 'GENERAL',
          documentTypeId: typ,
          mimeType: 'application/pdf',
          requiresPayrollAccess: o.lohn ?? false,
          sharedWithClientAt: o.geteilt ? new Date() : null,
          sharedByStaff: o.geteilt ? anna : null,
        },
      });
      const v = await owner.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: 'general',
          storageKey: `tenants/${tenantId}/none/${doc.id}.pdf`,
          storageVersionId: 'v1',
          sha256: Buffer.alloc(32, byte),
          sizeBytes: 4096n,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: anna,
        },
      });
      return {
        id: doc.id,
        key: v.storageKey,
        sha: Buffer.alloc(32, byte).toString('hex'),
        groesse: 4096,
      };
    }

    const ok = (daten: unknown): Antwort => ({ body: { ok: true, daten } });
    const nachweis = (
      d: { id: string; sha: string; groesse: number },
      extra: Record<string, unknown> = {},
    ) => ({
      id: 'nwboese1',
      dokumentId: d.id,
      dateiname: 'Kontoabstimmung.pdf',
      mime: 'application/pdf',
      groesse: d.groesse,
      sha256: d.sha,
      gesperrt: true,
      hochgeladenVon: anna,
      hochgeladenAm: new Date().toISOString(),
      ...extra,
    });

    const abrufe = (documentId: string) =>
      owner.auditLog.count({
        where: { tenantId, resourceId: documentId, action: 'document.download' },
      });

    beforeAll(async () => {
      ({ prismaOwner: owner } = await import('@taxtronik/db'));
      server = createServer((req, res) => {
        anfragen.push(`${req.method} ${req.url}`);
        req.resume();
        req.on('end', () => {
          const a = antwort(req);
          res.writeHead(a.status ?? 200, {
            'content-type': 'application/json',
            ...(a.headers ?? {}),
          });
          res.end(a.roh ? String(a.body) : JSON.stringify(a.body));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      // Konfiguration der kanzleikonsole auf den bösartigen Dienst (vor dem ersten Laden).
      process.env.TCMS_DEPLOYMENT = 'external';
      process.env.TCMS_URL = `http://127.0.0.1:${port}`;
      process.env.TCMS_SERVICE_TOKEN = randomBytes(32).toString('base64url');
      process.env.TCMS_ACTOR_KEY_ID = 'kk-boese';
      process.env.TCMS_ACTOR_PRIVATE_KEY = generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64');

      tenantId = (
        await owner.tenant.create({
          data: { slug: `tcms-rt3b-stub-${randomUUID()}`, name: 'RT3B Stub' },
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
      anna = await person('Anna Roth', 'ADMIN');
      leon = await person('Leon Brandt', 'EMPLOYEE');
      mandantA = await aktiverMandant('Talwind Outdoor GmbH');
      mandantB = await aktiverMandant('Seestern GmbH');
      jana = (
        await owner.clientContact.create({
          data: {
            tenantId,
            clientId: mandantA,
            email: 'jana@talwind.example',
            fullName: 'Jana Weller',
          },
        })
      ).id;
      typ = (
        await owner.documentType.create({
          data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
        })
      ).id;
      await owner.tenantSetting.create({
        data: { tenantId, key: 'modules', value: { tcms: true } },
      });
    }, 60_000);

    beforeEach(() => {
      m.gelesen.length = 0;
      anfragen.length = 0;
      alsStaff(anna, ['ADMIN']);
    });

    afterAll(async () => {
      server?.closeAllConnections();
      await new Promise<void>((r) => server?.close(() => r()));
      await owner?.$disconnect();
    });

    const anfrage = (pfad: string) => new NextRequest(`http://localhost${pfad}`);

    async function nachweisAbruf(mandantId = mandantA) {
      const { GET } =
        await import('@/app/api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route');
      const r = await GET(anfrage(`/api/staff/clients/${mandantId}/tcms/nachweise/nwboese1`), {
        params: Promise.resolve({ id: mandantId, nachweisId: 'nwboese1' }),
      });
      expect(anfragen.length, 'der Dienst wurde gefragt').toBeGreaterThan(0);
      return r;
    }

    it('RT3B-S1a: Nachweis verweist auf ein Dokument eines anderen Mandanten (gleicher Inhalt) – nicht ausgeliefert, kein Abrufnachweis', async () => {
      const fremd = await dokument(mandantB, 0x42);
      antwort = () => ok({ durchfuehrungId: DID, nachweis: nachweis(fremd) });
      const r = await nachweisAbruf();
      expect(r.status).toBe(404);
      expect(m.gelesen).toEqual([]);
      expect(await abrufe(fremd.id)).toBe(0);
    });

    it('RT3B-S1b: Nachweis mit abweichendem SHA-256 bzw. abweichender Größe – nicht ausgeliefert', async () => {
      const eigen = await dokument(mandantA, 0x43);
      for (const extra of [{ sha256: 'ab'.repeat(32) }, { groesse: 4095 }]) {
        antwort = () => ok({ durchfuehrungId: DID, nachweis: nachweis(eigen, extra) });
        const r = await nachweisAbruf();
        expect(r.status).toBe(409);
      }
      expect(m.gelesen).toEqual([]);
      expect(await abrufe(eigen.id)).toBe(0);
    });

    it('RT3B-S1c: Dateiname/Typ des Dienstes mit CR/LF, Header-Fragment und Bidi – Header nur aus der kanzleikonsole', async () => {
      const eigen = await dokument(mandantA, 0x44, { titel: 'Kontoabstimmung Oktober' });
      antwort = () =>
        ok({
          durchfuehrungId: DID,
          nachweis: nachweis(eigen, {
            dateiname: `x"\r\nSet-Cookie: a=b; filename="evil${RLO}fdp.exe`,
            mime: 'text/html',
          }),
        });
      const r = await nachweisAbruf();
      expect(r.status).toBe(200);
      expect(r.headers.get('content-disposition')).toBe(
        'attachment; filename="Kontoabstimmung Oktober.pdf"',
      );
      expect(r.headers.get('content-type')).toBe('application/pdf');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(m.gelesen).toEqual([eigen.key]);
    });

    it('RT3B-S1d: Nachweis auf ein Lohndokument des Mandanten – ohne Lohnrecht nicht ausgeliefert', async () => {
      const lohn = await dokument(mandantA, 0x45, { lohn: true });
      alsStaff(leon, ['EMPLOYEE']);
      antwort = () => ok({ durchfuehrungId: DID, nachweis: nachweis(lohn) });
      const r = await nachweisAbruf();
      expect(r.status).toBe(404);
      expect(m.gelesen).toEqual([]);
    });

    it('RT3B-S2: Ereignis-Anlage verweist auf ein Dokument eines anderen Mandanten bzw. auf einen anderen Hash – keine Bytes', async () => {
      const fremd = await dokument(mandantB, 0x46);
      const anlage = {
        dokumentId: fremd.id,
        dateiname: 'anlage.pdf',
        mime: 'application/pdf',
        groesse: fremd.groesse,
        sha256: fremd.sha,
      };
      antwort = () => ok(anlage);
      const { GET } = await import('@/app/api/staff/clients/[id]/tcms/ereignisse/anlage/route');
      const abruf = (h: string) =>
        GET(
          anfrage(
            `/api/staff/clients/${mandantA}/tcms/ereignisse/anlage?e=ereignisboese000001&h=${h}`,
          ),
          {
            params: Promise.resolve({ id: mandantA }),
          },
        );
      const r1 = await abruf(fremd.sha);
      expect(r1.status).toBeGreaterThanOrEqual(300);
      expect(r1.headers.get('content-disposition')).toBeNull();
      expect(r1.headers.get('location') ?? '').toMatch(/anlage=nicht-verfuegbar/);
      // Hash der Anfrage ≠ Hash des Verweises: 404.
      const r2 = await abruf('cd'.repeat(32));
      expect(r2.status).toBe(404);
      expect(m.gelesen).toEqual([]);
      expect(await abrufe(fremd.id)).toBe(0);
    });

    it('RT3B-S3: Portal-Anlage: nicht freigegebenes eigenes bzw. freigegebenes fremdes Dokument – keine Bytes; freigegebenes eigenes – ausgeliefert', async () => {
      alsJana();
      const privat = await dokument(mandantA, 0x47);
      const fremd = await dokument(mandantB, 0x48, { geteilt: true });
      const geteilt = await dokument(mandantA, 0x49, { geteilt: true });
      const { GET } =
        await import('@/app/api/portal/tcms/aufgaben/[id]/anlagen/[nachweisId]/route');
      const abruf = () =>
        GET(anfrage(`/api/portal/tcms/aufgaben/${DID}/anlagen/nwboese1`), {
          params: Promise.resolve({ id: DID, nachweisId: 'nwboese1' }),
        });
      for (const d of [privat, fremd]) {
        antwort = () => ok({ durchfuehrungId: DID, nachweis: nachweis(d) });
        const r = await abruf();
        expect(r.headers.get('content-disposition')).toBeNull();
        expect(r.headers.get('location') ?? '').toMatch(/anlage=nicht-verfuegbar/);
      }
      expect(m.gelesen).toEqual([]);
      // Andere Durchführung in der Antwort als im Pfad: 404.
      antwort = () =>
        ok({ durchfuehrungId: 'cmvfandere000000000001', nachweis: nachweis(geteilt) });
      expect((await abruf()).status).toBe(404);
      // Positivkontrolle: freigegebenes Dokument des Sitzungsmandanten.
      antwort = () => ok({ durchfuehrungId: DID, nachweis: nachweis(geteilt) });
      const r = await abruf();
      expect(r.status).toBe(200);
      expect(m.gelesen).toEqual([geteilt.key]);
    });

    it('RT3B-S4: Abgleich mit bösartigen Antworten berührt nur offene, unbestätigte Verknüpfungen dieses Mandanten', async () => {
      const { nachweisVerknuepfenTx, nachweisVerknuepfungBestaetigen } =
        await import('../durchfuehrung/verweis');
      const { withTenantContext } = await import('@taxtronik/db/tenant-context');
      const ctx = { tenantId, actorId: anna, actorType: 'STAFF' as const };
      const verknuepfen = async (clientId: string, byte: number) => {
        const d = await dokument(clientId, byte);
        const { verknuepfungId } = await withTenantContext(ctx, (tx) =>
          nachweisVerknuepfenTx(tx, { tenantId, mandantId: clientId, staffId: anna }, d.id, DID),
        );
        return { ...d, verknuepfungId };
      };
      const offen = await verknuepfen(mandantA, 0x50);
      const bestaetigt = await verknuepfen(mandantA, 0x51);
      expect(
        await nachweisVerknuepfungBestaetigen(ctx, bestaetigt.verknuepfungId, 'nwfest01'),
      ).toBe(true);
      const andererMandant = await verknuepfen(mandantB, 0x52);

      const { tcmsMandantSeite } = await import('@/server/tcms/seite');
      const { offeneNachweiseAbgleichen } = await import('../durchfuehrung/abgleich');
      const seite = await tcmsMandantSeite(mandantA);
      if (!seite.ok) throw new Error(`Seite: ${seite.zustand.art}`);
      const zeile = (id: string) =>
        owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id } });
      // Weit nach der Mindestgrenze des Abgleichs (5 Minuten).
      const spaeter = new Date(Date.now() + 3_600_000);

      // (1) Antwort nennt ein Dokument des anderen Mandanten: keine Entscheidung.
      antwort = () => ok({ dokumentId: andererMandant.id, nachweise: [] });
      expect(await offeneNachweiseAbgleichen(seite, DID, spaeter)).toMatchObject({
        bestaetigt: 0,
        freigegeben: 0,
      });
      // (2) Ungültige Antwort (unbekanntes Feld, Nachweis-ID mit Sonderzeichen): unverändert.
      antwort = () =>
        ok({
          dokumentId: offen.id,
          nachweise: [{ id: '../NW', durchfuehrungId: DID, entfernt: false, x: 1 }],
        });
      expect(await offeneNachweiseAbgleichen(seite, DID, spaeter)).toMatchObject({
        bestaetigt: 0,
        freigegeben: 0,
      });
      expect((await zeile(offen.verknuepfungId)).releasedAt).toBeNull();
      // (3) Bestätigung mit einer Nachweis-ID, die schon an einer anderen Verknüpfung hängt: nicht doppelt.
      antwort = () =>
        ok({
          dokumentId: offen.id,
          nachweise: [{ id: 'nwfest01', durchfuehrungId: DID, entfernt: false }],
        });
      await offeneNachweiseAbgleichen(seite, DID, spaeter);
      expect((await zeile(offen.verknuepfungId)).tcmsEvidenceId).not.toBe('nwfest01');
      // Bestätigte Verknüpfung und Verknüpfung des anderen Mandanten: nie berührt.
      expect(await zeile(bestaetigt.verknuepfungId)).toMatchObject({
        releasedAt: null,
        tcmsEvidenceId: 'nwfest01',
      });
      expect(await zeile(andererMandant.verknuepfungId)).toMatchObject({
        releasedAt: null,
        tcmsEvidenceId: null,
      });
      // Abfragen nur für Dokumente des Mandanten der Seite.
      expect(anfragen.length, 'der Dienst wurde gefragt').toBeGreaterThanOrEqual(3);
      for (const a of anfragen) {
        expect(a).not.toContain(andererMandant.id);
        expect(a).not.toContain(bestaetigt.id);
      }
    });

    it('RT3B-K-04: Dateiname des Dienstes mit Richtungssteuerzeichen wird nicht unisoliert angezeigt', async () => {
      const { NachweisListe } = await import('@/components/tcms/durchfuehrung/nachweis-liste');
      const html = await renderServerMarkup(
        <NachweisListe
          id="nachweise"
          titel="Nachweise"
          ebene="h2"
          nachweise={[
            nachweis(
              { id: randomUUID(), sha: '00'.repeat(32), groesse: 10 },
              { dateiname: `Rechnung${RLO}fdp.exe <img src=x onerror=alert(1)>` },
            ) as never,
          ]}
          mindest={1}
          anforderung="Beleg"
          ausgeblendet={0}
          namen={{ name: () => 'Anna Roth' }}
          abrufHref={(id) => `/api/x/${id}`}
          aenderbarBis="Einreichen"
          entfernen={() => null}
          fuss={null}
        />,
      );
      // HTML des Dienstes bleibt Text (React escapt) …
      expect(html).not.toContain('<img');
      // … aber ein U+202E kehrt die Anzeige um („Rechnungexe.pdf“), wenn er weder
      // entfernt (Zeichenregel) noch isoliert (<bdi>/dir="auto") wird.
      const isoliert = /<bdi[^>]*>[^<]*\u202e|dir="auto"[^>]*>[^<]*\u202e/.test(html);
      expect(html.includes(RLO) && !isoliert).toBe(false);
    });
    // Zuletzt: Die Ausfälle öffnen den Circuit-Breaker des Clients (gewollt); spätere
    // Tests würden sonst nur noch die feste Ausfallantwort sehen.
    it.each([
      [
        'Weiterleitung',
        (): Antwort => ({
          status: 302,
          headers: { location: 'http://127.0.0.1:9/x' },
          body: '',
          roh: true,
        }),
      ],
      [
        '403 ohne Grund mit Geheimtext',
        (): Antwort => ({
          status: 403,
          body: { ok: false, fehler: { code: 'NICHT_BERECHTIGT', meldung: GEHEIM } },
        }),
      ],
      [
        '500 mit Geheimtext',
        (): Antwort => ({
          status: 500,
          body: { ok: false, fehler: { code: 'INTERN', meldung: GEHEIM } },
        }),
      ],
      [
        'kein JSON',
        (): Antwort => ({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<p>${GEHEIM}</p>`,
          roh: true,
        }),
      ],
      [
        'unbekanntes Feld',
        (): Antwort =>
          ok({
            durchfuehrungId: DID,
            nachweis: nachweis({ id: randomUUID(), sha: '00'.repeat(32), groesse: 1 }),
            extra: GEHEIM,
          }),
      ],
    ])(
      'RT3B-S1e: Protokollangriff „%s“ – feste Antwort ohne Inhalte des Dienstes',
      async (_n, a) => {
        antwort = a;
        const r = await nachweisAbruf();
        expect(r.status).toBeGreaterThanOrEqual(400);
        const text = await r.text();
        expect(text).not.toContain(GEHEIM);
        expect(r.headers.get('content-disposition')).toBeNull();
        expect(m.gelesen).toEqual([]);
      },
    );
  },
);
