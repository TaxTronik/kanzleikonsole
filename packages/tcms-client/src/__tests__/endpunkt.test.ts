// TCMS Stufe 2: typisierter Aufruf aus dem Endpunktregister des Vertrags.
// Jede lokale Vorprüfung (Pfadparameter, Portal, health) hat einen Fall, der
// ohne die Prüfung scheitert; die Bestätigung prüft der Code des Dienstes.
import { ENDPUNKT_LISTE, ENDPUNKTE } from '@taxtronik/tcms-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TcmsClient, type TcmsAkteurAngaben } from '../client';
import { rufeEndpunkt } from '../endpunkt';
import { TcmsProtokollFehler, TcmsUngueltig } from '../fehler';
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
const PERSON = 'b1000000-0000-4000-8000-000000000001';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const KANZLEI: TcmsAkteurAngaben = {
  tnt: TENANT,
  sub: PERSON,
  knd: 'KANZLEI',
  nam: 'StB Dr. Anna Roth',
  rol: { adm: true, bt: true },
  cli: { id: MANDANT, bt: true, hb: false },
};
const KONTAKT: TcmsAkteurAngaben = {
  tnt: TENANT,
  sub: PERSON,
  knd: 'MANDANT',
  nam: 'Jana Weller',
  cli: { id: MANDANT, bt: false, hb: false },
};
const ICH = {
  art: 'KANZLEI',
  tenantId: TENANT,
  id: PERSON,
  name: 'StB Dr. Anna Roth',
  istAdmin: true,
  istBerufstraeger: true,
  mandant: null,
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

describe('rufeEndpunkt', () => {
  it('ruft einen Registereintrag mit Methode, Pfad und Antwortschema des Vertrags', async () => {
    const s = neueSchluessel();
    const srv = await starteServer((_a, res) => json(res, 200, { ok: true, daten: ICH }));
    server.push(srv);
    const client = new TcmsClient(clientOptionen(srv.url, s));
    const ergebnis = await rufeEndpunkt(client, ENDPUNKTE.ich, { params: {}, akteur: KANZLEI });
    expect(ergebnis.daten).toEqual(ICH);
    const [anfrage] = srv.empfangen;
    expect(anfrage!.target).toBe('/v1/ich');
    expect(payload(anfrage!).req).toMatchObject({ m: 'GET', p: '/v1/ich' });
    expect(pruefeEmpfangen(anfrage!, s)).toMatchObject({ ok: true });
  });

  it('prüft die Antwort gegen das Antwortschema des Registers', async () => {
    const srv = await starteServer((_a, res) =>
      json(res, 200, { ok: true, daten: { ...ICH, zusatz: 1 } }),
    );
    server.push(srv);
    const client = new TcmsClient(clientOptionen(srv.url, neueSchluessel()));
    const fehler = await fehlerVon(
      rufeEndpunkt(client, ENDPUNKTE.ich, { params: {}, akteur: KANZLEI }),
    );
    expect(fehler).toBeInstanceOf(TcmsProtokollFehler);
  });

  it('prüft Pfadparameter lokal mit dem Schema des Registers und sendet sonst nichts', async () => {
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    for (const params of [{ mandantId: 'kein-uuid' }, { mandantId: MANDANT, mehr: 'x' }, {}]) {
      const fehler = await fehlerVon(
        rufeEndpunkt(client, ENDPUNKTE.kontextLesen, {
          params: params as { mandantId: string },
          akteur: KANZLEI,
        }),
      );
      expect(fehler).toBeInstanceOf(TcmsUngueltig);
    }
    // Kanonisches Segment, passender Mandant: nur das Schema (UUID) weist ab.
    const schemaFehler = await fehlerVon(
      rufeEndpunkt(client, ENDPUNKTE.durchfuehrungLesen, {
        params: { mandantId: MANDANT, durchfuehrungId: 'kein-uuid' },
        akteur: KANZLEI,
      }),
    );
    expect(schemaFehler).toBeInstanceOf(TcmsUngueltig);
    expect((schemaFehler as TcmsUngueltig).felder).toEqual({
      params: ['passen nicht zum Endpunkt'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lässt Mandantenkontakte nur auf Portal-Endpunkte und health nur über health()', async () => {
    const fetchImpl = vi.fn();
    const client = new TcmsClient(
      clientOptionen('http://127.0.0.1:9', neueSchluessel(), { fetchImpl }),
    );
    const portalFehler = await fehlerVon(
      rufeEndpunkt(client, ENDPUNKTE.kontextLesen, {
        params: { mandantId: MANDANT },
        akteur: KONTAKT,
      }),
    );
    expect(portalFehler).toBeInstanceOf(TcmsUngueltig);
    expect((portalFehler as TcmsUngueltig).felder).toEqual({
      'akteur.knd': ['Mandantenkontakt auf Kanzlei-Endpunkt'],
    });
    const healthFehler = await fehlerVon(
      rufeEndpunkt(client, ENDPUNKTE.health, { params: {}, akteur: KANZLEI }),
    );
    expect(healthFehler).toBeInstanceOf(TcmsUngueltig);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('jeder Registereintrag lässt sich mit den Methoden des Clients abbilden', () => {
    expect(ENDPUNKT_LISTE.length).toBeGreaterThan(90);
    for (const e of ENDPUNKT_LISTE) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(e.methode);
      expect(e.pfad.startsWith('/v1/')).toBe(true);
      expect(e.mandantenbezogen).toBe(e.pfad.startsWith('/v1/mandanten/:mandantId'));
    }
  });
});
