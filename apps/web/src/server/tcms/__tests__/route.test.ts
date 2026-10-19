// TCMS Stufe 3: Route-Handler-Einstieg (server/tcms/route.ts) für Datei-Abrufe
// der Bereiche C und D. Prüfkette und Reihenfolge, Bindung von Mandant und
// Akteur an die Route, feste Antworten ohne Texte des Dienstes. Jede Regel
// hat einen Test, der ohne sie scheitert (Mutationsnachweis im Bericht).
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001, ACCESS-CLIENT-MODE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  reihenfolge: [] as string[],
  staff: null as unknown,
  portal: null as unknown,
  modulAn: true,
  konfiguriert: true,
  aktiv: true,
  zugriff: true,
  rufe: vi.fn(),
  kanzleiAkteurTx: vi.fn(),
  portalAkteurTx: vi.fn(),
  bereiche: [] as string[],
  kontexte: [] as unknown[],
  tx: { client: { findFirst: vi.fn() } },
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/auth/staff', () => ({
  staffAuth: vi.fn(async () => {
    m.reihenfolge.push('staffAuth');
    return m.staff;
  }),
}));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => {
    m.reihenfolge.push('portalAuth');
    return m.portal;
  }),
}));
vi.mock('@/server/settings/modules', () => ({
  readModules: vi.fn(async (ctx: unknown) => {
    m.reihenfolge.push('readModules');
    m.kontexte.push(ctx);
    return { modul: true };
  }),
}));
vi.mock('@/lib/module-registry', () => ({
  isModuleAreaEnabled: (_cfg: unknown, bereich: string) => {
    m.bereiche.push(bereich);
    return m.modulAn;
  },
}));
vi.mock('@/server/auth/rbac', () => ({
  canAccessClientTx: vi.fn(async () => {
    m.reihenfolge.push('canAccessClientTx');
    return m.zugriff;
  }),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: vi.fn(async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    m.kontexte.push(ctx);
    m.reihenfolge.push('tx:start');
    try {
      return await fn(m.tx);
    } finally {
      m.reihenfolge.push('tx:ende');
    }
  }),
}));
vi.mock('../dienst', async (original) => ({
  ...(await original<typeof import('../dienst')>()),
  tcmsKonfiguriert: () => m.konfiguriert,
  tcmsClient: () => (m.konfiguriert ? { client: true } : null),
  tcmsAktivTx: async () => {
    m.reihenfolge.push('tcmsAktivTx');
    return m.aktiv;
  },
}));
vi.mock('../akteur', async (original) => ({
  ...(await original<typeof import('../akteur')>()),
  kanzleiAkteurTx: async (...args: unknown[]) => {
    m.reihenfolge.push('kanzleiAkteurTx');
    return m.kanzleiAkteurTx(...args);
  },
  portalAkteurTx: async (...args: unknown[]) => {
    m.reihenfolge.push('portalAkteurTx');
    return m.portalAkteurTx(...args);
  },
}));
vi.mock('@taxtronik/tcms-client', async (original) => ({
  ...(await original<typeof import('@taxtronik/tcms-client')>()),
  rufeEndpunkt: async (...args: unknown[]) => {
    m.reihenfolge.push('rufeEndpunkt');
    return m.rufe(...args);
  },
}));

import {
  TcmsKonflikt,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsAkteurVerweigert } from '../akteur';
import {
  tcmsMandantRoute,
  tcmsPortalRoute,
  tcmsRouteLesen,
  type TcmsMandantRoute,
  type TcmsPortalRoute,
} from '../route';

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const MANDANT = '33333333-3333-4333-8333-333333333333';
const FREMD = '44444444-4444-4444-8444-444444444444';
const KONTAKT = '55555555-5555-4555-8555-555555555555';
const STAFF_SESSION = { user: { tenantId: TENANT, staffId: STAFF, roles: ['EMPLOYEE'] } };
const PORTAL_SESSION = {
  user: { tenantId: TENANT, contactId: KONTAKT, clientId: MANDANT, email: 'k@example.test' },
};
const MANDANT_AKTEUR = {
  tnt: TENANT,
  sub: STAFF,
  knd: 'KANZLEI',
  nam: 'Anna',
  rol: { adm: false, bt: true },
  cli: { id: MANDANT, bt: true, hb: false },
};
const PORTAL_AKTEUR = {
  tnt: TENANT,
  sub: KONTAKT,
  knd: 'MANDANT',
  nam: 'Kim',
  cli: { id: MANDANT, bt: false, hb: false },
};
const NACHWEIS = 'nachweis1';

beforeEach(() => {
  vi.clearAllMocks();
  m.reihenfolge.length = 0;
  m.kontexte.length = 0;
  m.bereiche.length = 0;
  m.staff = STAFF_SESSION;
  m.portal = PORTAL_SESSION;
  m.modulAn = true;
  m.konfiguriert = true;
  m.aktiv = true;
  m.zugriff = true;
  m.kanzleiAkteurTx.mockResolvedValue(MANDANT_AKTEUR);
  m.portalAkteurTx.mockResolvedValue(PORTAL_AKTEUR);
  m.tx.client.findFirst.mockResolvedValue({ id: MANDANT });
  m.rufe.mockResolvedValue({ daten: { ok: 'daten' }, requestId: 'req-1', status: 200 });
});

async function json(antwort: Response) {
  return { status: antwort.status, body: await antwort.json() };
}

async function abbruchVon(ergebnis: { ok: boolean; antwort?: Response }) {
  expect(ergebnis.ok).toBe(false);
  return json(ergebnis.antwort!);
}

async function mandantRoute(): Promise<TcmsMandantRoute> {
  const route = await tcmsMandantRoute(MANDANT);
  if (!route.ok) throw new Error('erwartet ok');
  return route;
}

describe('tcmsMandantRoute', () => {
  it('prüft Sitzung zuerst, dann Modul, dann in einer Transaktion Mandant, Zugriff, Aktivität und Akteur', async () => {
    const route = await mandantRoute();
    expect(m.reihenfolge).toEqual([
      'staffAuth',
      'readModules',
      'tx:start',
      'canAccessClientTx',
      'tcmsAktivTx',
      'kanzleiAkteurTx',
      'tx:ende',
    ]);
    expect(m.bereiche).toEqual(['tcms']);
    expect(m.kontexte).toEqual([
      { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' },
      { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' },
    ]);
    expect(m.tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: MANDANT, tenantId: TENANT },
      select: { id: true },
    });
    expect(m.kanzleiAkteurTx).toHaveBeenCalledWith(m.tx, STAFF_SESSION, { mandantId: MANDANT });
    expect(route).toMatchObject({ ok: true, art: 'MANDANT', mandantId: MANDANT });
    expect(route.akteur).toBe(MANDANT_AKTEUR);
  });

  it('führt den Mandanten kanonisch klein (gleich in Pfad und Bestätigung)', async () => {
    const route = await tcmsMandantRoute(MANDANT.toUpperCase());
    expect(route).toMatchObject({ ok: true, mandantId: MANDANT });
    expect(m.kanzleiAkteurTx).toHaveBeenCalledWith(m.tx, STAFF_SESSION, { mandantId: MANDANT });
  });

  it('401 ohne Sitzung, ohne Modul, Datenbank oder Akteur', async () => {
    m.staff = null;
    const { status, body } = await abbruchVon(await tcmsMandantRoute(MANDANT));
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(m.reihenfolge).toEqual(['staffAuth']);
    // Eine Sitzung ohne Person ist keine Sitzung.
    m.staff = { expires: '2099-01-01T00:00:00.000Z' };
    expect((await abbruchVon(await tcmsMandantRoute(MANDANT))).status).toBe(401);
    m.portal = { expires: '2099-01-01T00:00:00.000Z' };
    expect((await abbruchVon(await tcmsPortalRoute())).status).toBe(401);
    expect(m.reihenfolge).toEqual(['staffAuth', 'staffAuth', 'portalAuth']);
  });

  it('404 für ungültige IDs, bevor irgendetwas geladen wird', async () => {
    for (const id of ['abc', `${MANDANT}x`, '../x', '']) {
      const { status } = await abbruchVon(await tcmsMandantRoute(id));
      expect(status).toBe(404);
    }
    expect(m.reihenfolge.every((s) => s === 'staffAuth')).toBe(true);
  });

  it('404 bei ausgeschaltetem Modulbereich tcms oder ohne Konfiguration, ohne Transaktion', async () => {
    m.modulAn = false;
    expect((await abbruchVon(await tcmsMandantRoute(MANDANT))).status).toBe(404);
    m.modulAn = true;
    m.konfiguriert = false;
    expect((await abbruchVon(await tcmsMandantRoute(MANDANT))).status).toBe(404);
    expect(m.reihenfolge).not.toContain('tx:start');
    expect(m.bereiche).toEqual(['tcms', 'tcms']);
  });

  it('404 für Mandanten außerhalb des Tenants oder ohne Zugriff – ohne Akteur', async () => {
    m.tx.client.findFirst.mockResolvedValueOnce(null);
    expect((await abbruchVon(await tcmsMandantRoute(FREMD))).status).toBe(404);
    m.zugriff = false;
    const ohneZugriff = await abbruchVon(await tcmsMandantRoute(MANDANT));
    expect(ohneZugriff).toEqual({
      status: 404,
      body: { error: 'not_found', message: 'Nicht gefunden.' },
    });
    expect(m.kanzleiAkteurTx).not.toHaveBeenCalled();
  });

  it('404 bei inaktivem Tax-CMS, ohne Akteur', async () => {
    m.aktiv = false;
    expect((await abbruchVon(await tcmsMandantRoute(MANDANT))).status).toBe(404);
    expect(m.kanzleiAkteurTx).not.toHaveBeenCalled();
  });

  it('Verweigerung: veraltete Sitzung 401, sonst 404; anderes geht weiter', async () => {
    m.kanzleiAkteurTx.mockRejectedValueOnce(new TcmsAkteurVerweigert('SITZUNG_VERALTET'));
    expect(await abbruchVon(await tcmsMandantRoute(MANDANT))).toMatchObject({
      status: 401,
      body: { error: 'session_stale' },
    });
    m.kanzleiAkteurTx.mockRejectedValueOnce(new TcmsAkteurVerweigert('KEIN_MANDANTENZUGRIFF'));
    expect((await abbruchVon(await tcmsMandantRoute(MANDANT))).status).toBe(404);
    m.kanzleiAkteurTx.mockRejectedValueOnce(new Error('DB weg'));
    await expect(tcmsMandantRoute(MANDANT)).rejects.toThrow('DB weg');
  });

  it('Antworten sind nicht cachebar und ohne MIME-Sniffing', async () => {
    m.staff = null;
    const ergebnis = await tcmsMandantRoute(MANDANT);
    if (ergebnis.ok) throw new Error('erwartet Abbruch');
    expect(ergebnis.antwort.headers.get('cache-control')).toBe('private, no-store');
    expect(ergebnis.antwort.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('tcmsPortalRoute', () => {
  it('Sitzung zuerst, Modul, Mandant nur aus der Sitzung, Kontext des Kontakts', async () => {
    const route = (await tcmsPortalRoute()) as TcmsPortalRoute;
    expect(m.reihenfolge).toEqual([
      'portalAuth',
      'readModules',
      'tx:start',
      'tcmsAktivTx',
      'portalAkteurTx',
      'tx:ende',
    ]);
    expect(m.bereiche).toEqual(['tcms']);
    expect(m.kontexte[1]).toEqual({
      tenantId: TENANT,
      actorId: KONTAKT,
      actorType: 'CLIENT_CONTACT',
    });
    expect(route).toMatchObject({ ok: true, art: 'PORTAL', mandantId: MANDANT });
  });

  it('401 ohne Sitzung; 404 bei Modul aus oder ohne Portalzugang', async () => {
    m.portal = null;
    expect((await abbruchVon(await tcmsPortalRoute())).status).toBe(401);
    m.portal = PORTAL_SESSION;
    m.modulAn = false;
    expect((await abbruchVon(await tcmsPortalRoute())).status).toBe(404);
    m.modulAn = true;
    m.portalAkteurTx.mockRejectedValueOnce(new TcmsAkteurVerweigert('KEIN_PORTALZUGANG'));
    expect((await abbruchVon(await tcmsPortalRoute())).status).toBe(404);
    m.aktiv = false;
    expect((await abbruchVon(await tcmsPortalRoute())).status).toBe(404);
  });
});

describe('tcmsRouteLesen', () => {
  it('setzt Mandant und Akteur aus der Route, außerhalb jeder Transaktion', async () => {
    const route = await mandantRoute();
    m.reihenfolge.length = 0;
    const ergebnis = await tcmsRouteLesen(route, ENDPUNKTE.nachweisLesen, {
      params: { nachweisId: NACHWEIS, mandantId: FREMD } as never,
    });
    expect(ergebnis).toEqual({ ok: true, daten: { ok: 'daten' }, requestId: 'req-1' });
    expect(m.reihenfolge).toEqual(['rufeEndpunkt']);
    const [, endpunkt, eingabe] = m.rufe.mock.calls[0]!;
    expect(endpunkt).toBe(ENDPUNKTE.nachweisLesen);
    // Ein mandantId-Parameter des Handlers wird überschrieben, nie übernommen.
    expect(eingabe).toEqual({
      params: { nachweisId: NACHWEIS, mandantId: MANDANT },
      akteur: MANDANT_AKTEUR,
    });
  });

  it('Portal-Route: Mandant der Sitzung, nur Portal-Endpunkte', async () => {
    const route = (await tcmsPortalRoute()) as TcmsPortalRoute;
    await tcmsRouteLesen(route, ENDPUNKTE.portalAnlageLesen, { params: { nachweisId: NACHWEIS } });
    expect(m.rufe.mock.calls[0]![2]).toEqual({
      params: { nachweisId: NACHWEIS, mandantId: MANDANT },
      akteur: PORTAL_AKTEUR,
    });
    await expect(
      tcmsRouteLesen(route, ENDPUNKTE.nachweisLesen, { params: { nachweisId: NACHWEIS } }),
    ).rejects.toThrow(/kein Portal-Endpunkt/);
  });

  it('weist schreibende und mandantenlose Endpunkte als Programmierfehler ab', async () => {
    const route = await mandantRoute();
    await expect(tcmsRouteLesen(route, ENDPUNKTE.nachweisAnhaengen)).rejects.toThrow(
      /kein Lesepfad/,
    );
    await expect(tcmsRouteLesen(route, ENDPUNKTE.durchfuehrungEinreichen)).rejects.toThrow(
      /kein Lesepfad/,
    );
    await expect(tcmsRouteLesen(route, ENDPUNKTE.arbeitskorbLesen)).rejects.toThrow(
      /kein Lesepfad/,
    );
    await expect(tcmsRouteLesen(route, ENDPUNKTE.auditLesen)).rejects.toThrow(
      /keinen Mandanten im Pfad/,
    );
    expect(m.rufe).not.toHaveBeenCalled();
  });

  it('Fehler des Dienstes → feste Antworten, nie der Text des Dienstes', async () => {
    const route = await mandantRoute();
    const fall = async (fehler: Error) => {
      m.rufe.mockRejectedValueOnce(fehler);
      const ergebnis = await tcmsRouteLesen(route, ENDPUNKTE.nachweisLesen, {
        params: { nachweisId: NACHWEIS },
      });
      if (ergebnis.ok) throw new Error('erwartet Abbruch');
      return json(ergebnis.antwort);
    };
    expect((await fall(new TcmsNichtGefunden({ status: 404 }))).status).toBe(404);
    expect((await fall(new TcmsUngueltig({ params: ['x'] }, { lokal: true }))).status).toBe(404);
    const verboten = await fall(
      new TcmsNichtBerechtigt({ status: 403, meldung: 'Grund mit Namen Anna Roth' }),
    );
    expect(verboten.status).toBe(403);
    expect(JSON.stringify(verboten.body)).not.toContain('Anna Roth');
    expect((await fall(new TcmsUngueltig({ x: ['y'] }, { status: 400 }))).status).toBe(400);
    expect((await fall(new TcmsKonflikt({ status: 409 }))).status).toBe(400);
    expect(
      await fall(new TcmsNichtVerfuegbar('ZEITLIMIT', { requestId: 'req-ausfall' })),
    ).toMatchObject({ status: 503, body: { error: 'tcms_unavailable', requestId: 'req-ausfall' } });
    const protokoll = await fall(new TcmsProtokollFehler('SCHEMA', { requestId: 'kaputt id!' }));
    expect(protokoll.status).toBe(503);
    expect(protokoll.body.requestId).toBeUndefined();
    m.rufe.mockRejectedValueOnce(new Error('kein TCMS-Fehler'));
    await expect(
      tcmsRouteLesen(route, ENDPUNKTE.nachweisLesen, { params: { nachweisId: NACHWEIS } }),
    ).rejects.toThrow('kein TCMS-Fehler');
    // Protokoll ohne Meldung des Dienstes.
    expect(JSON.stringify(m.log.info.mock.calls)).not.toContain('Anna Roth');
  });

  it('ohne Client (Dienst zwischenzeitlich abgeschaltet) 404', async () => {
    const route = await mandantRoute();
    m.konfiguriert = false;
    const ergebnis = await tcmsRouteLesen(route, ENDPUNKTE.nachweisLesen, {
      params: { nachweisId: NACHWEIS },
    });
    expect((await abbruchVon(ergebnis)).status).toBe(404);
    expect(m.rufe).not.toHaveBeenCalled();
  });
});
