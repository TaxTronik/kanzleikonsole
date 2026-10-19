// TCMS Stufe 2: Transport des TCMS-Clients gegen lokale Testserver.
// Jede Sicherheitsregel (Signatur-/Pfad-/Body-Bindung, Größenlimit, Redirect,
// Wiederholung, Fehlerabbildung ohne Rohkörper) hat hier einen Fall, der ohne
// die Regel scheitert. Die Bestätigung prüft der Code des Dienstes
// (pruefeAkteur aus dem vendored Vertrag) gegen die rohe Anfrage.
import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { CircuitBreaker } from '@taxtronik/http-utils/resilience';
import { MandantenListeSchema } from '@taxtronik/tcms-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NUR_SYSTEMAKTEUR, PERSONEN_AKTEURE, TcmsClient, type TcmsAkteurAngaben } from '../client';
import {
  TcmsFehler,
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '../fehler';
import {
  clientOptionen,
  geschlossenerPort,
  json,
  neueSchluessel,
  payload,
  pruefeEmpfangen,
  starteServer,
  type TestServer,
} from './testserver';

const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const PERSON = 'b1000000-0000-4000-8000-000000000001';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const AKTEUR: TcmsAkteurAngaben = {
  tnt: TENANT,
  sub: PERSON,
  knd: 'KANZLEI',
  nam: 'StB Dr. Anna Roth',
  rol: { adm: true, bt: true },
  cli: { id: MANDANT, bt: true, hb: false },
};
const OHNE_CLI: TcmsAkteurAngaben = { ...AKTEUR, cli: undefined };
const Daten = z.object({ wert: z.number() }).strict();
/** Breaker, der in Tests mit vielen Protokollfehlern hintereinander nicht öffnet. */
const offen = () => new CircuitBreaker({ failureThreshold: 1000, resetTimeoutMs: 1 });
const ok = (daten: unknown = { wert: 1 }) => ({ ok: true, daten });

const server: TestServer[] = [];
async function mitServer(...args: Parameters<typeof starteServer>): Promise<TestServer> {
  const s = await starteServer(...args);
  server.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(server.splice(0).map((s) => s.schliessen()));
  vi.restoreAllMocks();
});

async function fehlerVon(p: Promise<unknown>): Promise<TcmsFehler> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(TcmsFehler);
    return error as TcmsFehler;
  }
  throw new Error('kein Fehler');
}

describe('Signatur-, Pfad- und Body-Bindung', () => {
  it('signiert genau das gesendete Target, auch mit Umlauten und Sonderzeichen in der Query', async () => {
    const s = neueSchluessel();
    const srv = await mitServer((_a, res) => json(res, 200, ok()));
    const client = new TcmsClient(clientOptionen(srv.url, s));
    const suche = "Müller & Söhne O'Brien (GmbH) *100 %* a=b+c #?/\\ ~ € 😀";
    const ergebnis = await client.aufruf({
      methode: 'GET',
      pfad: '/v1/mandanten/:mandantId/kontext',
      params: { mandantId: MANDANT },
      query: { stand: '2026-10-16', suche },
      antwortSchema: Daten,
      akteur: AKTEUR,
    });
    expect(ergebnis).toEqual({
      daten: { wert: 1 },
      status: 200,
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    const [anfrage] = srv.empfangen;
    expect(
      anfrage!.target.startsWith(`/v1/mandanten/${MANDANT}/kontext?stand=2026-10-16&suche=`),
    ).toBe(true);
    expect(payload(anfrage!).req).toMatchObject({ m: 'GET', p: anfrage!.target });
    expect(pruefeEmpfangen(anfrage!, s)).toMatchObject({ ok: true });
    expect(new URLSearchParams(anfrage!.target.split('?')[1]).get('suche')).toBe(suche);
  });

  it('bindet den Body: Hash über genau die gesendeten Bytes, einmal serialisiert', async () => {
    const s = neueSchluessel();
    const srv = await mitServer((_a, res) => json(res, 200, ok()));
    const client = new TcmsClient(clientOptionen(srv.url, s));
    const body = { mandantIds: [MANDANT], bt: [MANDANT], hb: [], notiz: 'Grüße, „Zitat" 😀' };
    // Ein toJSON mit Seiteneffekt zeigt, dass genau einmal serialisiert wird.
    const einmal = vi.fn(() => body);
    await client.aufruf({
      methode: 'POST',
      pfad: '/v1/portfolio',
      body: { toJSON: einmal },
      antwortSchema: Daten,
      akteur: OHNE_CLI,
    });
    expect(einmal).toHaveBeenCalledTimes(1);
    const [anfrage] = srv.empfangen;
    expect(anfrage!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(anfrage!.body.toString('utf8'))).toEqual(body);
    expect(pruefeEmpfangen(anfrage!, s)).toMatchObject({ ok: true });
    // Gegenprobe: ein anderer Body (auch nur andere Leerzeichen) passt nicht mehr.
    const anders = { ...anfrage!, body: Buffer.from(JSON.stringify(body, null, 1)) };
    expect(pruefeEmpfangen(anders, s)).toEqual({ ok: false, grund: 'REQ_BODY' });
  });

  it('erzeugt je Aufruf eine frische, kurzlebige Bestätigung mit Header und Token', async () => {
    const s = neueSchluessel();
    const srv = await mitServer((_a, res) => json(res, 200, ok()));
    const jetzt = new Date('2026-10-19T08:00:00Z');
    const client = new TcmsClient(clientOptionen(srv.url, s, { uhr: () => jetzt }));
    const aufruf = () =>
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI });
    await aufruf();
    await aufruf();
    const [a, b] = srv.empfangen.map(payload);
    expect(a!.jti).not.toBe(b!.jti);
    expect(a!.iat).toBe(Math.floor(jetzt.getTime() / 1000));
    expect((a!.exp as number) - (a!.iat as number)).toBeLessThanOrEqual(60);
    expect(a).toMatchObject({ iss: 'kanzleikonsole', aud: 'tcms', knd: 'KANZLEI', tnt: TENANT });
    expect(srv.empfangen[0]!.headers.authorization).toBe(`Bearer ${s.token}`);
    expect(pruefeEmpfangen(srv.empfangen[0]!, s, jetzt)).toMatchObject({ ok: true });
  });

  it('sendet nichts, wenn cli nicht zum Mandantenpfad passt (Bindung wie im Dienst)', async () => {
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    for (const akteur of [OHNE_CLI, { ...AKTEUR, cli: { id: PERSON, bt: false, hb: false } }]) {
      const fehler = await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/mandanten/:mandantId/kontext',
          params: { mandantId: MANDANT },
          antwortSchema: Daten,
          akteur,
        }),
      );
      expect(fehler).toBeInstanceOf(TcmsUngueltig);
      expect((fehler as TcmsUngueltig).felder).toEqual({
        'akteur.cli': ['passt nicht zum Mandantenpfad'],
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prüft Eingaben lokal und sendet bei Fehlern nichts', async () => {
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    const basis = { antwortSchema: Daten, akteur: OHNE_CLI };
    const faelle = [
      { ...basis, methode: 'GET' as const, pfad: '/v1/audit', body: {} },
      { ...basis, methode: 'POST' as const, pfad: '/v1/portfolio', body: 'x'.repeat(256 * 1024) },
      { ...basis, methode: 'POST' as const, pfad: '/v1/portfolio', body: () => 1 },
      {
        ...basis,
        methode: 'POST' as const,
        pfad: '/v1/portfolio',
        bodySchema: MandantenListeSchema,
        body: { mandantIds: [MANDANT, MANDANT] },
      },
      {
        ...basis,
        methode: 'GET' as const,
        pfad: '/v1/audit',
        querySchema: z.object({ stand: z.iso.date() }).strict(),
        query: { stand: 'gestern' },
      },
      {
        ...basis,
        methode: 'GET' as const,
        pfad: '/v1/audit',
        akteur: { ...OHNE_CLI, nam: 'x'.repeat(201) },
      },
      { ...basis, methode: 'TRACE' as never, pfad: '/v1/audit' },
      { ...basis, methode: 'GET' as const, pfad: '/v1/audit', zeitlimitMs: 0 },
      { ...basis, methode: 'GET' as const, pfad: '/v1/audit', maxAntwortBytes: 2 ** 40 },
    ];
    for (const fall of faelle) {
      const fehler = await fehlerVon(client.aufruf(fall));
      expect(fehler).toBeInstanceOf(TcmsUngueltig);
      expect((fehler as TcmsUngueltig).lokal).toBe(true);
      expect(fehler.message).toBe('TCMS: Anfrage ungültig (nicht gesendet)');
    }
    // Akteursfehler nennen nur Feldpfade, nie Werte (Name, IDs).
    const akteurFehler = (await fehlerVon(client.aufruf({ ...faelle[5]! }))) as TcmsUngueltig;
    expect(akteurFehler.felder).toEqual({ akteur: ['nam'] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Antwortgrenzen', () => {
  it('folgt keiner Umleitung (redirect: error)', async () => {
    const srv = await mitServer((a, res) => {
      if (a.target === '/v1/anders') return json(res, 200, ok());
      res.writeHead(302, { location: '/v1/anders' });
      res.end();
    });
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    const fehler = await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    );
    expect(fehler).toMatchObject({ name: 'TcmsProtokollFehler', grund: 'REDIRECT' });
    expect(srv.empfangen.map((a) => a.target)).toEqual(['/v1/audit']);
  });

  it('bricht eine gestreamte Antwort über dem Limit ab und liest den Rest nicht', async () => {
    const GESAMT = 32 * 1024 * 1024;
    let geschrieben = 0;
    let verbindungZu: () => void = () => undefined;
    const zu = new Promise<void>((resolve) => (verbindungZu = resolve));
    const srv = await mitServer(async (_a, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => verbindungZu());
      const stueck = Buffer.alloc(64 * 1024, 0x20);
      res.write('{"ok":true,"daten":{"wert":1},"x":"');
      while (geschrieben < GESAMT && !res.destroyed) {
        geschrieben += stueck.length;
        if (!res.write(stueck)) await new Promise((r) => res.once('drain', r).once('close', r));
      }
      res.end('"}');
    });
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    const fehler = await fehlerVon(
      client.aufruf({
        methode: 'GET',
        pfad: '/v1/audit',
        antwortSchema: Daten,
        akteur: OHNE_CLI,
        maxAntwortBytes: 256 * 1024,
      }),
    );
    expect(fehler).toMatchObject({ name: 'TcmsProtokollFehler', grund: 'ANTWORT_ZU_GROSS' });
    await zu;
    expect(geschrieben).toBeLessThan(GESAMT);
  });

  it('begrenzt standardmäßig auf 8 MiB und erlaubt größere Grenzen je Aufruf', async () => {
    const gross = JSON.stringify({ ok: true, daten: { wert: 1, x: 'y'.repeat(9 * 1024 * 1024) } });
    const srv = await mitServer((_a, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(gross);
    });
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    const Gross = z.object({ wert: z.number(), x: z.string() }).strict();
    const aufruf = (maxAntwortBytes?: number) =>
      client.aufruf({
        methode: 'GET',
        pfad: '/v1/audit',
        antwortSchema: Gross,
        akteur: OHNE_CLI,
        maxAntwortBytes,
      });
    expect(await fehlerVon(aufruf())).toMatchObject({ grund: 'ANTWORT_ZU_GROSS' });
    expect((await aufruf(16 * 1024 * 1024)).daten.wert).toBe(1);
  });

  it('weist eine angekündigte Länge über dem Limit ab, ohne zu lesen', async () => {
    const srv = await mitServer((_a, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(9 * 1024 * 1024),
      });
      res.write('{"ok":true');
      // Der Rest kommt nie: Ein Client, der läse, liefe ins Zeitlimit.
    });
    const client = new TcmsClient(
      clientOptionen(srv.url, neueSchluessel(), { zeitlimitMs: 5_000 }),
    );
    const beginn = Date.now();
    const fehler = await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    );
    expect(fehler).toMatchObject({ grund: 'ANTWORT_ZU_GROSS' });
    expect(Date.now() - beginn).toBeLessThan(4_000);
  });

  it('akzeptiert nur application/json', async () => {
    const srv = await mitServer((_a, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(JSON.stringify(ok()));
    });
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    expect(
      await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      ),
    ).toMatchObject({ grund: 'CONTENT_TYPE' });
  });

  it('prüft Umschlag und Daten streng (unbekannte Felder, doppelte Schlüssel, __proto__)', async () => {
    const antworten: Array<[string, string]> = [
      ['SCHEMA', JSON.stringify({ ok: true, daten: { wert: 1, extra: 2 } })],
      ['SCHEMA', JSON.stringify({ ok: true, daten: { wert: 'eins' } })],
      ['UMSCHLAG', JSON.stringify({ ok: true, daten: { wert: 1 }, zusatz: 1 })],
      ['UMSCHLAG', JSON.stringify({ daten: { wert: 1 } })],
      ['JSON', '{"ok":true,"daten":{"wert":1,"wert":2}}'],
      ['JSON', '{"ok":true,"daten":{"wert":1,"__proto__":{}}}'],
      ['JSON', '{"ok":true'],
    ];
    const srv = await mitServer(() => undefined);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel(), { breaker: offen() }));
    for (const [grund, text] of antworten) {
      srv.setze((_a, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(text);
      });
      const fehler = await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      );
      expect(fehler, text).toMatchObject({ name: 'TcmsProtokollFehler', grund });
    }
    srv.setze((_a, res) => json(res, 200, ok({ wert: 1, extra: 2 })));
    const schema = (await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    )) as TcmsProtokollFehler;
    expect(schema.pfade).toEqual(['daten']);
  });
});

describe('Fehlerabbildung', () => {
  const GEHEIM = 'Sachverhalt-Mandant-Geheim';

  it('bildet jeden Fehlercode typisiert ab, ohne Rohkörper in message', async () => {
    const srv = await mitServer(() => undefined);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel(), { breaker: offen() }));
    const faelle: Array<[number, Record<string, unknown>, new (...a: never[]) => TcmsFehler]> = [
      [400, { code: 'UNGUELTIG', felder: { 'body.mandantIds': ['doppelt'] } }, TcmsUngueltig],
      [401, { code: 'NICHT_AUTHENTIFIZIERT' }, TcmsNichtAuthentifiziert],
      [
        403,
        { code: 'NICHT_BERECHTIGT', meldung: GEHEIM, grund: 'VIER_AUGEN' },
        TcmsNichtBerechtigt,
      ],
      [404, { code: 'NICHT_GEFUNDEN' }, TcmsNichtGefunden],
      [409, { code: 'KONFLIKT', meldung: GEHEIM }, TcmsKonflikt],
      [500, { code: 'INTERN' }, TcmsNichtVerfuegbar],
      [405, { code: 'METHODE_NICHT_ERLAUBT' }, TcmsProtokollFehler],
      [413, { code: 'ZU_GROSS' }, TcmsProtokollFehler],
    ];
    for (const [status, fehler, klasse] of faelle) {
      srv.setze((_a, res) => json(res, status, { ok: false, fehler }));
      const f = await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      );
      expect(f, String(status)).toBeInstanceOf(klasse);
      expect(f.status).toBe(status);
      expect(f.code).toBe(fehler.code);
      expect(f.requestId).toBe('11111111-2222-4333-8444-555555555555');
      expect(f.message).not.toContain(GEHEIM);
      expect(f.message).not.toContain('doppelt');
    }
    srv.setze((_a, res) =>
      json(res, 403, {
        ok: false,
        fehler: { code: 'NICHT_BERECHTIGT', meldung: GEHEIM, grund: 'VIER_AUGEN' },
      }),
    );
    const berechtigt = (await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    )) as TcmsNichtBerechtigt;
    expect(berechtigt.grund).toBe(GEHEIM);
    // TCMS s5: maschinenlesbarer Grund aus `fehler.grund`, nie in `message`.
    expect(berechtigt.verweigerung).toBe('VIER_AUGEN');
    expect(berechtigt.message).not.toContain('VIER_AUGEN');
    // Ein 403 ohne Grund widerspricht dem Vertrag: Protokollfehler, kein 403.
    srv.setze((_a, res) =>
      json(res, 403, { ok: false, fehler: { code: 'NICHT_BERECHTIGT', meldung: GEHEIM } }),
    );
    expect(
      await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      ),
    ).toBeInstanceOf(TcmsProtokollFehler);
    // … ebenso ein unbekannter Grund oder ein Grund an einem anderen Code.
    for (const fehler of [
      { code: 'NICHT_BERECHTIGT', grund: 'IRGENDWAS' },
      { code: 'KONFLIKT', grund: 'VIER_AUGEN' },
    ]) {
      srv.setze((_a, res) =>
        json(res, fehler.code === 'KONFLIKT' ? 409 : 403, { ok: false, fehler }),
      );
      expect(
        await fehlerVon(
          client.aufruf({
            methode: 'GET',
            pfad: '/v1/audit',
            antwortSchema: Daten,
            akteur: OHNE_CLI,
          }),
        ),
      ).toBeInstanceOf(TcmsProtokollFehler);
    }
    srv.setze((_a, res) =>
      json(res, 400, { ok: false, fehler: { code: 'UNGUELTIG', felder: { stand: ['ungültig'] } } }),
    );
    const ungueltig = (await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    )) as TcmsUngueltig;
    expect(ungueltig).toMatchObject({ lokal: false, felder: { stand: ['ungültig'] } });
  });

  it('meldet Umschläge, deren Code nicht zum Status passt, oder Fremdkörper als Protokollfehler', async () => {
    const srv = await mitServer(() => undefined);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel(), { breaker: offen() }));
    const faelle: Array<[number, unknown, string]> = [
      [404, { ok: false, fehler: { code: 'KONFLIKT' } }, 'STATUS'],
      [418, { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } }, 'STATUS'],
      [400, { ok: false, fehler: { code: 'UNGUELTIG', detail: GEHEIM } }, 'UMSCHLAG'],
      [500, { error: GEHEIM }, 'UMSCHLAG'],
      [200, { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } }, 'UMSCHLAG'],
      [404, { ok: true, daten: { wert: 1 } }, 'UMSCHLAG'],
      [204, null, 'STATUS'],
    ];
    for (const [status, body, grund] of faelle) {
      srv.setze((_a, res) => {
        if (status !== 204) return json(res, status, body);
        res.writeHead(204);
        res.end();
      });
      const f = await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      );
      if (status === 204) expect(f).toBeInstanceOf(TcmsProtokollFehler);
      else expect(f, `${status}`).toMatchObject({ name: 'TcmsProtokollFehler', grund });
      expect(f.message).not.toContain(GEHEIM);
      expect(inspect(f)).not.toContain(GEHEIM);
    }
  });

  it('verrät weder Token noch Schlüssel in Client, Fehlern oder Logs', async () => {
    const s = neueSchluessel();
    const client = new TcmsClient(
      clientOptionen(await geschlossenerPort(), s, {
        wiederholung: { retries: 0, baseDelayMs: 0 },
      }),
    );
    const f = await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    );
    const privat = s.privat.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    for (const text of [
      JSON.stringify(client),
      inspect(client, { depth: 9 }),
      inspect(f),
      JSON.stringify(f),
    ]) {
      expect(text).not.toContain(s.token);
      expect(text).not.toContain(privat);
      expect(text).not.toContain('Bearer');
    }
    expect(f).toMatchObject({
      name: 'TcmsNichtVerfuegbar',
      grund: 'TRANSPORT',
      systemCode: 'ECONNREFUSED',
    });
  });
});

describe('Wiederholung, Zeitlimit, Breaker', () => {
  it('wiederholt GET bei 503 mit neuer Bestätigung je Versuch', async () => {
    const s = neueSchluessel();
    let n = 0;
    const srv = await mitServer((_a, res) => (++n < 3 ? json(res, 503, {}) : json(res, 200, ok())));
    const client = new TcmsClient(clientOptionen(srv.url, s));
    const ergebnis = await client.aufruf({
      methode: 'GET',
      pfad: '/v1/audit',
      antwortSchema: Daten,
      akteur: OHNE_CLI,
    });
    expect(ergebnis.daten).toEqual({ wert: 1 });
    expect(srv.empfangen).toHaveLength(3);
    expect(new Set(srv.empfangen.map((a) => payload(a).jti)).size).toBe(3);
    for (const anfrage of srv.empfangen)
      expect(pruefeEmpfangen(anfrage, s)).toMatchObject({ ok: true });
  });

  it('wiederholt GET bei Transportfehlern, aber nie POST, 4xx, 500 oder Zeitlimit', async () => {
    const echt = (url: string, init: RequestInit) => fetch(url, init);
    const fetchImpl = vi.fn(echt);
    const tot = new TcmsClient(
      clientOptionen(await geschlossenerPort(), neueSchluessel(), { fetchImpl }),
    );
    await fehlerVon(
      tot.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    fetchImpl.mockClear();
    await fehlerVon(
      tot.aufruf({
        methode: 'POST',
        pfad: '/v1/portfolio',
        body: {},
        antwortSchema: Daten,
        akteur: OHNE_CLI,
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const srv = await mitServer(() => undefined);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel(), { zeitlimitMs: 200 }));
    const faelle: Array<[string, (res: import('node:http').ServerResponse) => void, string]> = [
      ['POST 503', (res) => json(res, 503, {}), 'POST'],
      [
        'GET 404',
        (res) => json(res, 404, { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } }),
        'GET',
      ],
      ['GET 500', (res) => json(res, 500, { ok: false, fehler: { code: 'INTERN' } }), 'GET'],
      ['GET 502', (res) => json(res, 502, {}), 'GET'],
      ['GET Zeitlimit', () => undefined, 'GET'],
    ];
    for (const [name, antwort, methode] of faelle) {
      srv.empfangen.length = 0;
      srv.setze((_a, res) => antwort(res));
      await fehlerVon(
        client.aufruf({
          methode: methode as 'GET' | 'POST',
          pfad: methode === 'GET' ? '/v1/audit' : '/v1/portfolio',
          body: methode === 'GET' ? undefined : {},
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      );
      expect(srv.empfangen, name).toHaveLength(1);
    }
  });

  it('bricht nach dem Zeitlimit je Aufruf ab', async () => {
    const srv = await mitServer(() => undefined);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    const beginn = Date.now();
    const f = await fehlerVon(
      client.aufruf({
        methode: 'GET',
        pfad: '/v1/audit',
        antwortSchema: Daten,
        akteur: OHNE_CLI,
        zeitlimitMs: 100,
      }),
    );
    expect(f).toMatchObject({ name: 'TcmsNichtVerfuegbar', grund: 'ZEITLIMIT' });
    expect(Date.now() - beginn).toBeLessThan(2_000);
  });

  it('401 mit Connection: close vor dem Body: typisiert, kein Retry, Verbindung danach neu', async () => {
    const s = neueSchluessel();
    const srv = await mitServer(
      (a, res) => {
        if (a.headers.authorization !== `Bearer ${s.token}`) {
          res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ ok: false, fehler: { code: 'NICHT_AUTHENTIFIZIERT' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok()));
      },
      { ohneBody: true },
    );
    const falsch = new TcmsClient(clientOptionen(srv.url, { ...s, token: neueSchluessel().token }));
    const f = await fehlerVon(
      falsch.aufruf({
        methode: 'POST',
        pfad: '/v1/portfolio',
        body: { notiz: 'n'.repeat(200 * 1024) },
        antwortSchema: Daten,
        akteur: OHNE_CLI,
      }),
    );
    // Je nach Zeitpunkt des Schließens: die 401 oder ein Transportfehler – nie ein Erfolg.
    expect(
      f instanceof TcmsNichtAuthentifiziert || (f as TcmsNichtVerfuegbar).grund === 'TRANSPORT',
    ).toBe(true);
    expect(srv.empfangen).toHaveLength(1);
    const g = await fehlerVon(
      falsch.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    );
    expect(g).toBeInstanceOf(TcmsNichtAuthentifiziert);
    expect(srv.empfangen).toHaveLength(2);
    const richtig = new TcmsClient(clientOptionen(srv.url, s));
    await expect(
      richtig.aufruf({ methode: 'GET', pfad: '/v1/audit', antwortSchema: Daten, akteur: OHNE_CLI }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('öffnet den Breaker nur bei Ausfällen, nicht bei fachlichen Antworten', async () => {
    const srv = await mitServer((_a, res) =>
      json(res, 404, { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } }),
    );
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel(), { breaker }));
    const aufruf = () =>
      fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: Daten,
          akteur: OHNE_CLI,
        }),
      );
    for (let i = 0; i < 3; i++) expect(await aufruf()).toBeInstanceOf(TcmsNichtGefunden);
    expect(breaker.getState()).toBe('closed');
    srv.setze((_a, res) => json(res, 500, { ok: false, fehler: { code: 'INTERN' } }));
    await aufruf();
    await aufruf();
    expect(breaker.getState()).toBe('open');
    const anzahl = srv.empfangen.length;
    expect(await aufruf()).toMatchObject({ name: 'TcmsNichtVerfuegbar', grund: 'BREAKER' });
    expect(srv.empfangen).toHaveLength(anzahl);
  });
});

describe('health()', () => {
  it('sendet nur das Dienst-Token, keinen Akteur, und prüft das Schema', async () => {
    const s = neueSchluessel();
    const srv = await mitServer((_a, res) =>
      json(res, 200, ok({ version: '0.1.0', datenbank: 'ok' })),
    );
    const client = new TcmsClient(clientOptionen(srv.url, s));
    expect((await client.health()).daten).toEqual({ version: '0.1.0', datenbank: 'ok' });
    const [anfrage] = srv.empfangen;
    expect(anfrage).toMatchObject({ methode: 'GET', target: '/v1/health' });
    expect(anfrage!.headers.authorization).toBe(`Bearer ${s.token}`);
    expect(anfrage!.headers['x-tcms-akteur']).toBeUndefined();
    srv.setze((_a, res) => json(res, 200, ok({ version: '0.1.0', datenbank: 'ok', host: 'db' })));
    expect(await fehlerVon(client.health())).toMatchObject({ grund: 'SCHEMA' });
  });

  it('hat ein kurzes Standard-Zeitlimit', async () => {
    const srv = await mitServer(() => undefined);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    const beginn = Date.now();
    expect(await fehlerVon(client.health({ zeitlimitMs: 100 }))).toMatchObject({
      grund: 'ZEITLIMIT',
    });
    expect(Date.now() - beginn).toBeLessThan(2_000);
  });
});

describe('Konstruktor', () => {
  it('verweigert ungültige Konfiguration ohne Werte in der Meldung', () => {
    const s = neueSchluessel();
    const basis = clientOptionen('http://127.0.0.1:3200', s).config;
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const faelle = [
      { ...basis, url: 'http://127.0.0.1:3200/tcms' },
      { ...basis, url: 'ftp://127.0.0.1' },
      { ...basis, url: 'kein-url' },
      { ...basis, serviceToken: '' },
      { ...basis, actorKeyId: 'kid mit leerzeichen' },
      { ...basis, actorPrivateKey: s.oeffentlich },
      { ...basis, actorPrivateKey: rsa },
    ];
    for (const config of faelle) {
      expect(() => new TcmsClient({ config }), JSON.stringify(config.url)).toThrow(/^TcmsClient: /);
    }
    expect(() => new TcmsClient({ config: basis, lebensdauerS: 61 })).toThrow(/Lebensdauer/);
    expect(() => new TcmsClient({ config: basis, lebensdauerS: 0 })).toThrow(/Lebensdauer/);
    expect(
      () => new TcmsClient({ config: { ...basis, url: 'http://127.0.0.1:3200/' } }),
    ).not.toThrow();
  });
});

describe('Akteursarten des Clients (Stufe 4)', () => {
  const SYSTEM: TcmsAkteurAngaben = {
    tnt: TENANT,
    sub: 'c1000000-0000-4000-8000-0000000000aa',
    knd: 'SYSTEM',
    nam: 'Zustellung kanzleikonsole',
  };

  it('bestätigt ohne Angabe nur Personen und signiert keinen Systemakteur', async () => {
    expect(PERSONEN_AKTEURE).toEqual(['KANZLEI', 'MANDANT']);
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    const fehler = await fehlerVon(
      client.aufruf({
        methode: 'GET',
        pfad: '/v1/nachrichten/offen',
        antwortSchema: Daten,
        akteur: SYSTEM,
      }),
    );
    expect(fehler).toBeInstanceOf(TcmsUngueltig);
    expect((fehler as TcmsUngueltig).felder).toEqual({
      'akteur.knd': ['Akteursart für diesen Client nicht zugelassen'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ein Systemclient signiert nur den Systemakteur, keine Person', async () => {
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), {
        fetchImpl,
        akteurArten: NUR_SYSTEMAKTEUR,
      }),
    );
    const fehler = await fehlerVon(
      client.aufruf({ methode: 'GET', pfad: '/v1/ich', antwortSchema: Daten, akteur: OHNE_CLI }),
    );
    expect((fehler as TcmsUngueltig).felder).toEqual({
      'akteur.knd': ['Akteursart für diesen Client nicht zugelassen'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ein Systemakteur mit rol oder cli wird nie signiert', async () => {
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), {
        fetchImpl,
        akteurArten: NUR_SYSTEMAKTEUR,
      }),
    );
    for (const akteur of [
      { ...SYSTEM, rol: { adm: true, bt: true } },
      { ...SYSTEM, cli: { id: MANDANT, bt: false, hb: false } },
    ]) {
      const fehler = await fehlerVon(
        client.aufruf({
          methode: 'GET',
          pfad: '/v1/nachrichten/offen',
          antwortSchema: Daten,
          akteur,
        }),
      );
      expect(fehler).toBeInstanceOf(TcmsUngueltig);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verweigert leere, unbekannte, doppelte und gemischte Akteursarten', () => {
    const config = clientOptionen('http://127.0.0.1:3200', neueSchluessel()).config;
    for (const akteurArten of [[], ['ADMIN'], ['KANZLEI', 'KANZLEI'], ['SYSTEM', 'KANZLEI']]) {
      expect(
        () => new TcmsClient({ config, akteurArten: akteurArten as never }),
        JSON.stringify(akteurArten),
      ).toThrow(/^TcmsClient: /);
    }
  });
});
