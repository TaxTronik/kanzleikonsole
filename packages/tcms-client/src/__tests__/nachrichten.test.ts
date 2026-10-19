// TCMS Stufe 4: Transport des Postausgangs (Abruf, Zustellbestätigung und
// Meldung „unzustellbar“, s6) mit dem Systemakteur. Die Bestätigung prüft der Code des Dienstes; jede lokale
// Sperre (Personen-Client, Person als Akteur) hat einen Fall ohne Senden.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NUR_SYSTEMAKTEUR, TcmsClient, type TcmsAkteurAngaben } from '../client';
import { TcmsKonflikt, TcmsNichtGefunden, TcmsProtokollFehler, TcmsUngueltig } from '../fehler';
import {
  holeOffeneNachrichten,
  meldeNachrichtUnzustellbar,
  meldeNachrichtZugestellt,
  NACHRICHT_UNZUSTELLBAR_GRUENDE,
} from '../nachrichten';
import {
  clientOptionen,
  json,
  neueSchluessel,
  payload,
  pruefeEmpfangen,
  starteServer,
  type TestServer,
} from './testserver';

const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const SYSTEM: TcmsAkteurAngaben = {
  tnt: TENANT,
  sub: 'c1000000-0000-4000-8000-0000000000aa',
  knd: 'SYSTEM',
  nam: 'Zustellung kanzleikonsole',
};
const NACHRICHT = {
  id: 'cmnachricht0001',
  mandantId: 'a1000000-0000-4000-8000-000000004711',
  empfaengerId: 'b1000000-0000-4000-8000-000000000011',
  empfaengerArt: 'KONTAKT',
  zweck: 'FREIGABE_CODE',
  betreff: 'Bestätigungscode',
  text: 'Code 123456',
  erstelltAm: '2026-10-19T08:00:00.000Z',
  daten: {
    freigabeId: 'cmfreigabe0001',
    art: 'BESCHREIBUNG',
    titel: 'CMS-Beschreibung v1.2',
    version: '1.2',
    code: '123456',
    gueltigBis: '2026-10-26T08:00:00.000Z',
    sha256: null,
  },
};

const server: TestServer[] = [];
afterEach(async () => {
  await Promise.all(server.splice(0).map((s) => s.schliessen()));
  vi.restoreAllMocks();
});

async function fehlerVon(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error('kein Fehler');
}

describe('Postausgang über den Systemakteur', () => {
  it('holt offene Nachrichten mit limit und prüft sie gegen den Vertrag', async () => {
    const s = neueSchluessel();
    const srv = await starteServer((_a, res) =>
      json(res, 200, { ok: true, daten: { nachrichten: [NACHRICHT] } }),
    );
    server.push(srv);
    const client = new TcmsClient(clientOptionen(srv.url, s, { akteurArten: NUR_SYSTEMAKTEUR }));
    const { daten } = await holeOffeneNachrichten(client, { akteur: SYSTEM, limit: 50 });
    expect(daten.nachrichten).toEqual([NACHRICHT]);
    const [anfrage] = srv.empfangen;
    expect(anfrage).toMatchObject({ methode: 'GET', target: '/v1/nachrichten/offen?limit=50' });
    expect(payload(anfrage!)).toMatchObject({ knd: 'SYSTEM', tnt: TENANT });
    expect(pruefeEmpfangen(anfrage!, s)).toMatchObject({ ok: true });
  });

  it('eine Nachricht außerhalb des Vertrags ist ein Protokollfehler', async () => {
    const srv = await starteServer((_a, res) =>
      json(res, 200, {
        ok: true,
        daten: { nachrichten: [{ ...NACHRICHT, empfaengerArt: 'KANZLEI' }] },
      }),
    );
    server.push(srv);
    const client = new TcmsClient(
      clientOptionen(srv.url, neueSchluessel(), { akteurArten: NUR_SYSTEMAKTEUR }),
    );
    const fehler = await fehlerVon(holeOffeneNachrichten(client, { akteur: SYSTEM, limit: 50 }));
    expect(fehler).toBeInstanceOf(TcmsProtokollFehler);
  });

  it('meldet die Zustellung per POST ohne Body; 404 kommt als TcmsNichtGefunden', async () => {
    const s = neueSchluessel();
    const srv = await starteServer((a, res) =>
      a.target.includes('unbekannt')
        ? json(res, 404, { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } })
        : json(res, 200, {
            ok: true,
            daten: { nachrichtId: 'cmnachricht0001', zugestellt: true },
          }),
    );
    server.push(srv);
    const client = new TcmsClient(clientOptionen(srv.url, s, { akteurArten: NUR_SYSTEMAKTEUR }));
    const { daten } = await meldeNachrichtZugestellt(client, {
      akteur: SYSTEM,
      nachrichtId: 'cmnachricht0001',
    });
    expect(daten).toEqual({ nachrichtId: 'cmnachricht0001', zugestellt: true });
    expect(srv.empfangen[0]).toMatchObject({
      methode: 'POST',
      target: '/v1/nachrichten/cmnachricht0001/zugestellt',
    });
    expect(srv.empfangen[0]!.body.length).toBe(0);
    expect(pruefeEmpfangen(srv.empfangen[0]!, s)).toMatchObject({ ok: true });
    const fehler = await fehlerVon(
      meldeNachrichtZugestellt(client, { akteur: SYSTEM, nachrichtId: 'unbekannt' }),
    );
    expect(fehler).toBeInstanceOf(TcmsNichtGefunden);
  });

  it('meldet „unzustellbar“ mit festem Grund als JSON-Body; 409 und 404 als Fehlerklassen', async () => {
    const s = neueSchluessel();
    const srv = await starteServer((a, res) =>
      a.target.includes('konflikt')
        ? json(res, 409, { ok: false, fehler: { code: 'KONFLIKT' } })
        : a.target.includes('unbekannt')
          ? json(res, 404, { ok: false, fehler: { code: 'NICHT_GEFUNDEN' } })
          : json(res, 200, {
              ok: true,
              daten: { nachrichtId: 'cmnachricht0001', unzustellbar: true, grund: 'ABGELAUFEN' },
            }),
    );
    server.push(srv);
    const client = new TcmsClient(clientOptionen(srv.url, s, { akteurArten: NUR_SYSTEMAKTEUR }));
    const { daten } = await meldeNachrichtUnzustellbar(client, {
      akteur: SYSTEM,
      nachrichtId: 'cmnachricht0001',
      grund: 'ABGELAUFEN',
    });
    expect(daten).toEqual({
      nachrichtId: 'cmnachricht0001',
      unzustellbar: true,
      grund: 'ABGELAUFEN',
    });
    expect(srv.empfangen[0]).toMatchObject({
      methode: 'POST',
      target: '/v1/nachrichten/cmnachricht0001/unzustellbar',
    });
    expect(JSON.parse(srv.empfangen[0]!.body.toString('utf8'))).toEqual({ grund: 'ABGELAUFEN' });
    expect(pruefeEmpfangen(srv.empfangen[0]!, s)).toMatchObject({ ok: true });
    expect(
      await fehlerVon(
        meldeNachrichtUnzustellbar(client, {
          akteur: SYSTEM,
          nachrichtId: 'konflikt',
          grund: 'SONSTIGES',
        }),
      ),
    ).toBeInstanceOf(TcmsKonflikt);
    expect(
      await fehlerVon(
        meldeNachrichtUnzustellbar(client, {
          akteur: SYSTEM,
          nachrichtId: 'unbekannt',
          grund: 'SONSTIGES',
        }),
      ),
    ).toBeInstanceOf(TcmsNichtGefunden);
    expect([...NACHRICHT_UNZUSTELLBAR_GRUENDE]).toEqual([
      'EMPFAENGER_UNGUELTIG',
      'KEIN_PORTALZUGANG',
      'ABGELAUFEN',
      'SONSTIGES',
    ]);
  });

  it('meldet „unzustellbar“ nie mit fremdem Grund, Personen-Client oder ungültiger ID', async () => {
    const fetchImpl = vi.fn();
    const system = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), {
        fetchImpl,
        akteurArten: NUR_SYSTEMAKTEUR,
      }),
    );
    const personen = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    const faelle: Array<[TcmsClient, string, string]> = [
      [system, 'cmnachricht0001', 'KONTAKT_UNBESTAETIGT'],
      [system, 'cmnachricht0001', ''],
      [system, '../mandanten', 'SONSTIGES'],
      [personen, 'cmnachricht0001', 'SONSTIGES'],
    ];
    for (const [client, nachrichtId, grund] of faelle) {
      expect(
        await fehlerVon(
          meldeNachrichtUnzustellbar(client, {
            akteur: SYSTEM,
            nachrichtId,
            grund: grund as 'SONSTIGES',
          }),
        ),
        `${nachrichtId} ${grund}`,
      ).toBeInstanceOf(TcmsUngueltig);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sendet nichts mit einem Personen-Client oder einer ungültigen Nachrichten-ID', async () => {
    const fetchImpl = vi.fn();
    const personen = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    expect(
      await fehlerVon(holeOffeneNachrichten(personen, { akteur: SYSTEM, limit: 50 })),
    ).toBeInstanceOf(TcmsUngueltig);
    const system = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), {
        fetchImpl,
        akteurArten: NUR_SYSTEMAKTEUR,
      }),
    );
    for (const nachrichtId of ['../mandanten', 'a b', '']) {
      expect(
        await fehlerVon(meldeNachrichtZugestellt(system, { akteur: SYSTEM, nachrichtId })),
        nachrichtId,
      ).toBeInstanceOf(TcmsUngueltig);
    }
    expect(
      await fehlerVon(holeOffeneNachrichten(system, { akteur: SYSTEM, limit: 101 })),
    ).toBeInstanceOf(TcmsUngueltig);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
