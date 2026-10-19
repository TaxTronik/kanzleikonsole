// =============================================================================
// Vertragstest gegen eine laufende TCMS-API (TCMS Stufe 2).
//
// Läuft nur mit TCMS_CONTRACT_TESTS=1 über vitest.contract.config.ts (nicht im
// Unit-Lauf). Er prüft den Client gegen den echten Dienst: Health, signierte
// Lese- und Schreibaufrufe, Bindung von Pfad, Query und Body sowie die
// Abweisungen (falscher Schlüssel/Token, fremder Mandant, Portal-Akteur auf
// Kanzlei-Endpunkt, manipulierter Body, Replay). Das Größenlimit prüft ein
// lokaler Testserver.
//
// Start (eigene TCMS-Kopie, nur lesen; Pfade wie in der Entwicklungsumgebung):
//   git -C /home/claude/tcms worktree add --detach /home/claude/wt/tcms-kkct main
//   cd /home/claude/wt/tcms-kkct && pnpm install --frozen-lockfile && pnpm db:generate
//   bash /home/claude/work/tcms-mkdb.sh tcms_kkct /home/claude/wt/tcms-kkct
//   node scripts/akteur-schluessel.mjs > <sicherer Ort>   # kid, SPKI, PKCS#8 – nie loggen
//   TCMS_SERVICE_TOKENS=<token> TCMS_ACTOR_PUBLIC_KEYS=<kid>=<spki> \
//     DATABASE_URL=postgresql://tcms_app:…@127.0.0.1:55432/tcms_kkct \
//     HOST=127.0.0.1 PORT=<frei> pnpm api
// Dann in packages/tcms-client:
//   TCMS_CONTRACT_TESTS=1 TCMS_URL=http://127.0.0.1:<port> TCMS_SERVICE_TOKEN=<token> \
//     TCMS_ACTOR_PRIVATE_KEY=<pkcs8> TCMS_ACTOR_KEY_ID=<kid> pnpm test:contract
// Ausführlich: docs/development/tcms-anbindung.md, Abschnitt 6.
// =============================================================================

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { getTcmsConfig, type TcmsConfig } from '@taxtronik/config/env-schema';
import {
  AKTEUR_HEADER,
  KontextAntwortSchema,
  KontextQuerySchema,
  MandantenListeSchema,
  PortalUebersichtAntwortSchema,
  PortfolioAntwortSchema,
  bodySha256,
  signiereAkteur,
} from '@taxtronik/tcms-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TcmsClient, type FetchImpl, type TcmsAkteurAngaben } from '../client';
import {
  TcmsFehler,
  TcmsNichtAuthentifiziert,
  TcmsNichtGefunden,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '../fehler';
import { starteServer, type TestServer } from './testserver';

const enabled = process.env.TCMS_CONTRACT_TESTS === '1';

// Feste Demo-IDs aus /home/claude/tcms/packages/db/seeds/demo.ts.
const DEMO_TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const ANNA = 'b1000000-0000-4000-8000-000000000001';
const JANA = 'b1000000-0000-4000-8000-000000000011';
const mid = (datev: string) => `a1000000-0000-4000-8000-${datev.padStart(12, '0')}`;
const TALWIND = mid('4711');
const ALLE = [mid('4711'), mid('4720'), mid('4733'), mid('4698'), mid('4752')];

const KANZLEI: TcmsAkteurAngaben = {
  tnt: DEMO_TENANT,
  sub: ANNA,
  knd: 'KANZLEI',
  nam: 'StB Dr. Anna Roth',
  rol: { adm: true, bt: true },
};
const mitMandant = (id: string): TcmsAkteurAngaben => ({
  ...KANZLEI,
  cli: { id, bt: true, hb: false },
});
const PORTAL: TcmsAkteurAngaben = {
  tnt: DEMO_TENANT,
  sub: JANA,
  knd: 'MANDANT',
  nam: 'Jana Weller',
  cli: { id: TALWIND, bt: false, hb: false },
};

async function fehlerVon(p: Promise<unknown>): Promise<TcmsFehler> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(TcmsFehler);
    return error as TcmsFehler;
  }
  throw new Error('kein Fehler');
}

(enabled ? describe : describe.skip)('TCMS-Vertragstest gegen den laufenden Dienst', () => {
  const config = (
    enabled ? getTcmsConfig({ ...process.env, TCMS_DEPLOYMENT: 'external' }) : null
  ) as TcmsConfig;
  const keinRetry = { retries: 0, baseDelayMs: 0 };
  const client = enabled ? new TcmsClient({ config, wiederholung: keinRetry }) : (null as never);
  const kontext = (akteur: TcmsAkteurAngaben, mandantId = TALWIND, c: TcmsClient = client) =>
    c.aufruf({
      methode: 'GET',
      pfad: '/v1/mandanten/:mandantId/kontext',
      params: { mandantId },
      query: { stand: '2026-10-16' },
      querySchema: KontextQuerySchema,
      antwortSchema: KontextAntwortSchema,
      akteur,
    });

  /** Client mit eigenem fetch, der die gesendete Anfrage festhält oder verändert. */
  function mitFetch(fetchImpl: FetchImpl, zusatz: Partial<TcmsConfig> = {}): TcmsClient {
    return new TcmsClient({
      config: { ...config, serviceToken: config.serviceToken, ...zusatz },
      fetchImpl,
      wiederholung: keinRetry,
    });
  }

  it('Health mit Dienst-Token', async () => {
    const { daten, requestId } = await client.health();
    expect(daten.datenbank).toBe('ok');
    expect(daten.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('signierter GET /v1/mandanten/:id/kontext für Demo-Mandant und Demo-Kanzleiperson', async () => {
    const { daten, status } = await kontext(mitMandant(TALWIND));
    expect(status).toBe(200);
    expect(daten.heute).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('POST mit Body: Mandantenliste über req.b gebunden (Portfolio)', async () => {
    const body = { mandantIds: ALLE, bt: [TALWIND], hb: [] };
    const { daten } = await client.aufruf({
      methode: 'POST',
      pfad: '/v1/portfolio',
      body,
      bodySchema: MandantenListeSchema,
      antwortSchema: PortfolioAntwortSchema,
      akteur: KANZLEI,
    });
    expect(daten.zeilen.length).toBeGreaterThan(0);
    expect(daten.zeilen.every((z) => ALLE.includes(z.mandant.id))).toBe(true);
  });

  it('Query mit Umlauten und Sonderzeichen: Bestätigung angenommen (400 statt 401)', async () => {
    // Der Dienst prüft die Bestätigung vor der Query: 400 UNGUELTIG beweist,
    // dass gesendetes und signiertes Target byte-gleich waren.
    const f = await fehlerVon(
      client.aufruf({
        methode: 'GET',
        pfad: '/v1/audit',
        query: { aktion: "Müller & Söhne O'Brien (100 %) *ä+ü=ß/?#€ 😀" },
        antwortSchema: z.unknown(),
        akteur: KANZLEI,
      }),
    );
    expect(f).toBeInstanceOf(TcmsUngueltig);
    expect(f).toMatchObject({ status: 400, lokal: false });
  });

  it('Portal-Akteur auf Portal-Endpunkt des eigenen Mandanten', async () => {
    const { daten } = await client.aufruf({
      methode: 'GET',
      pfad: '/v1/mandanten/:mandantId/portal/uebersicht',
      params: { mandantId: TALWIND },
      antwortSchema: PortalUebersichtAntwortSchema,
      akteur: PORTAL,
    });
    expect(daten.mandant.id).toBe(TALWIND);
  });

  it('negativ: falscher Schlüssel, unbekannte kid, falsches Token → 401', async () => {
    const fremd = generateKeyPairSync('ed25519').privateKey;
    for (const zusatz of [
      { actorPrivateKey: fremd },
      { actorKeyId: 'kk-unbekannt' },
      { serviceToken: randomBytes(32).toString('base64url') },
    ]) {
      const c = new TcmsClient({
        config: { ...config, serviceToken: config.serviceToken, ...zusatz },
        wiederholung: keinRetry,
      });
      expect(await fehlerVon(kontext(mitMandant(TALWIND), TALWIND, c))).toBeInstanceOf(
        TcmsNichtAuthentifiziert,
      );
    }
  });

  it('negativ: fremder Mandant → 404', async () => {
    const fremd = randomUUID();
    expect(await fehlerVon(kontext(mitMandant(fremd), fremd))).toBeInstanceOf(TcmsNichtGefunden);
  });

  it('negativ: cli ≠ Mandant im Pfad (am Client vorbei signiert) → 404', async () => {
    const pfad = `/v1/mandanten/${TALWIND}/kontext`;
    const jetzt = Math.floor(Date.now() / 1000);
    const token = signiereAkteur(
      {
        ...mitMandant(mid('4720')),
        iss: 'kanzleikonsole',
        aud: 'tcms',
        iat: jetzt,
        exp: jetzt + 30,
        jti: randomBytes(24).toString('base64url'),
        req: { m: 'GET', p: pfad, b: bodySha256(new Uint8Array(0)) },
      },
      { kid: config.actorKeyId, privateKey: config.actorPrivateKey },
    );
    const res = await fetch(new URL(pfad, config.url), {
      headers: { authorization: `Bearer ${config.serviceToken}`, [AKTEUR_HEADER]: token },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, fehler: { code: 'NICHT_GEFUNDEN' } });
  });

  it('negativ: Portal-Akteur auf Kanzlei-Endpunkt → 404', async () => {
    expect(await fehlerVon(kontext(PORTAL))).toBeInstanceOf(TcmsNichtGefunden);
  });

  it('negativ: Body nach der Signatur verändert → 401', async () => {
    const manipuliert = mitFetch((url, init) => {
      const original = Buffer.from(init.body as Uint8Array).toString('utf8');
      const anders = original.replace(TALWIND, mid('4720'));
      expect(anders).not.toBe(original);
      return fetch(url, { ...init, body: anders });
    });
    const f = await fehlerVon(
      manipuliert.aufruf({
        methode: 'POST',
        pfad: '/v1/portfolio',
        body: { mandantIds: [TALWIND], bt: [], hb: [] },
        antwortSchema: PortfolioAntwortSchema,
        akteur: KANZLEI,
      }),
    );
    expect(f).toBeInstanceOf(TcmsNichtAuthentifiziert);
  });

  it('negativ: Replay derselben Bestätigung → 401', async () => {
    let gesendet: { url: string; init: RequestInit } | null = null;
    const merkt = mitFetch((url, init) => {
      gesendet = { url, init };
      return fetch(url, init);
    });
    await kontext(mitMandant(TALWIND), TALWIND, merkt);
    const { url, init } = gesendet!;
    const zweiter = await fetch(url, { method: init.method, headers: init.headers });
    expect(zweiter.status).toBe(401);
    expect(zweiter.headers.get('connection')).toBe('close');
    expect(await zweiter.json()).toEqual({ ok: false, fehler: { code: 'NICHT_AUTHENTIFIZIERT' } });
  });

  it('Größenlimit auch gegen echte Antworten (je Aufruf)', async () => {
    const f = await fehlerVon(
      client.aufruf({
        methode: 'GET',
        pfad: '/v1/mandanten/:mandantId/kontext',
        params: { mandantId: TALWIND },
        antwortSchema: KontextAntwortSchema,
        akteur: mitMandant(TALWIND),
        maxAntwortBytes: 512,
      }),
    );
    expect(f).toBeInstanceOf(TcmsProtokollFehler);
    expect(f).toMatchObject({ grund: 'ANTWORT_ZU_GROSS' });
  });

  describe('Antwort über dem Größenlimit (Testserver, nicht TCMS)', () => {
    let srv: TestServer;
    afterAll(async () => srv?.schliessen());

    it('bricht beim Standardlimit von 8 MiB ab', async () => {
      srv = await starteServer((_a, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, daten: { x: 'y'.repeat(9 * 1024 * 1024) } }));
      });
      const c = new TcmsClient({
        config: { ...config, url: srv.url, serviceToken: config.serviceToken },
      });
      const f = await fehlerVon(
        c.aufruf({
          methode: 'GET',
          pfad: '/v1/audit',
          antwortSchema: z.unknown(),
          akteur: KANZLEI,
        }),
      );
      expect(f).toMatchObject({ name: 'TcmsProtokollFehler', grund: 'ANTWORT_ZU_GROSS' });
    });
  });
});
