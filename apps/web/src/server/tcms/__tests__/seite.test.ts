// TCMS Stufe 3: Seiten-Helfer (server/tcms/seite.ts). Prüfkette und
// Reihenfolge der Einstiege, Bindung von Mandant, Akteur und Mandantenliste an
// die Seite, Abbildung der Fehler und Namensauflösung. Die Akteursabbildung
// selbst prüft akteur-db.test.ts gegen PostgreSQL.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001, ACCESS-CLIENT-MODE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  reihenfolge: [] as string[],
  konfiguriert: true,
  rufe: vi.fn(),
  kanzleiAkteurTx: vi.fn(),
  listeTx: vi.fn(),
  portalAkteurTx: vi.fn(),
  assertAktiv: vi.fn(),
  tx: {
    client: { findFirst: vi.fn() },
    staffUser: { findMany: vi.fn() },
    clientContact: { findMany: vi.fn() },
  },
  kontexte: [] as unknown[],
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    m.reihenfolge.push('notFound');
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (ziel: string) => {
    throw new Error(`NEXT_REDIRECT:${ziel}`);
  },
}));
vi.mock('@/server/auth/client-page-access', () => ({
  requireClientPageAccess: vi.fn(async (id: string) => {
    m.reihenfolge.push(`requireClientPageAccess:${id}`);
    return STAFF_SESSION;
  }),
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async (opts?: { admin?: boolean }) => {
    m.reihenfolge.push(`requireStaffPage:${opts?.admin ? 'admin' : 'alle'}`);
    return STAFF_SESSION;
  }),
}));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => {
    m.reihenfolge.push('portalAuth');
    return PORTAL_SESSION;
  }),
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/settings/module-page', () => ({
  requireModulePage: vi.fn(async (oberflaeche: string, bereich: string) => {
    m.reihenfolge.push(`requireModulePage:${oberflaeche}:${bereich}`);
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
  assertTcmsAktivTx: async (...args: unknown[]) => {
    m.reihenfolge.push('assertTcmsAktivTx');
    return m.assertAktiv(...args);
  },
}));
vi.mock('../akteur', async (original) => ({
  ...(await original<typeof import('../akteur')>()),
  kanzleiAkteurTx: async (...args: unknown[]) => {
    m.reihenfolge.push('kanzleiAkteurTx');
    return m.kanzleiAkteurTx(...args);
  },
  kanzleiMandantenListeTx: async (...args: unknown[]) => {
    m.reihenfolge.push('kanzleiMandantenListeTx');
    return m.listeTx(...args);
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
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
} from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsAkteurVerweigert } from '../akteur';
import { TcmsInaktivError } from '../dienst';
import {
  tcmsAdminSeite,
  tcmsKanzleiSeite,
  tcmsLesen,
  tcmsLesenOptional,
  tcmsMandantSeite,
  tcmsNamenLesen,
  tcmsPortalSeite,
  type TcmsKanzleiSeite,
  type TcmsMandantSeite,
  type TcmsPortalSeite,
} from '../seite';

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const MANDANT = '33333333-3333-4333-8333-333333333333';
const FREMD = '44444444-4444-4444-8444-444444444444';
const KONTAKT = '55555555-5555-4555-8555-555555555555';
const STAFF_SESSION = { user: { tenantId: TENANT, staffId: STAFF, roles: ['EMPLOYEE'] } };
const PORTAL_SESSION = {
  user: { tenantId: TENANT, contactId: KONTAKT, clientId: MANDANT, email: 'k@example.test' },
};
const KANZLEI_AKTEUR = {
  tnt: TENANT,
  sub: STAFF,
  knd: 'KANZLEI',
  nam: 'Anna',
  rol: { adm: false, bt: true },
};
const MANDANT_AKTEUR = { ...KANZLEI_AKTEUR, cli: { id: MANDANT, bt: true, hb: false } };
const PORTAL_AKTEUR = {
  tnt: TENANT,
  sub: KONTAKT,
  knd: 'MANDANT',
  nam: 'Kim',
  cli: { id: MANDANT, bt: false, hb: false },
};
const LISTE = { mandantIds: [MANDANT, FREMD], bt: [MANDANT], hb: [] };

beforeEach(() => {
  vi.clearAllMocks();
  m.reihenfolge.length = 0;
  m.kontexte.length = 0;
  m.konfiguriert = true;
  m.assertAktiv.mockResolvedValue(undefined);
  m.kanzleiAkteurTx.mockImplementation(async (_tx, _s, opts?: { mandantId?: string }) =>
    opts?.mandantId ? MANDANT_AKTEUR : KANZLEI_AKTEUR,
  );
  m.listeTx.mockResolvedValue({ akteur: KANZLEI_AKTEUR, liste: LISTE });
  m.portalAkteurTx.mockResolvedValue(PORTAL_AKTEUR);
  m.tx.client.findFirst.mockResolvedValue({ id: MANDANT, name: 'Talwind GmbH', datevNo: '10001' });
  m.rufe.mockResolvedValue({ daten: { ok: 'daten' }, requestId: 'req-1', status: 200 });
});

async function mandantSeite(): Promise<TcmsMandantSeite> {
  const seite = await tcmsMandantSeite(MANDANT);
  if (!seite.ok) throw new Error('erwartet ok');
  return seite;
}

describe('tcmsMandantSeite', () => {
  it('prüft Zugriff zuerst, dann Modul, dann in einer Transaktion Mandant, Aktivität und Akteur', async () => {
    const seite = await mandantSeite();
    expect(m.reihenfolge).toEqual([
      `requireClientPageAccess:${MANDANT}`,
      'requireModulePage:staff:tcms',
      'tx:start',
      'assertTcmsAktivTx',
      'kanzleiAkteurTx',
      'tx:ende',
    ]);
    expect(m.kanzleiAkteurTx).toHaveBeenCalledWith(m.tx, STAFF_SESSION, { mandantId: MANDANT });
    expect(m.tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: MANDANT, tenantId: TENANT },
      select: { id: true, name: true, datevNo: true },
    });
    expect(seite).toMatchObject({
      art: 'MANDANT',
      mandantId: MANDANT,
      akteur: MANDANT_AKTEUR,
      mandant: { name: 'Talwind GmbH' },
      basis: `/staff/clients/${MANDANT}/tcms`,
    });
  });

  it('zeigt „nicht eingerichtet“ ohne Konfiguration, ohne die Datenbank zu fragen', async () => {
    m.konfiguriert = false;
    expect(await tcmsMandantSeite(MANDANT)).toEqual({
      ok: false,
      zustand: { art: 'NICHT_KONFIGURIERT' },
    });
    expect(m.reihenfolge).not.toContain('tx:start');
    // Zugriff und Modul wurden trotzdem zuerst geprüft.
    expect(m.reihenfolge.slice(0, 2)).toEqual([
      `requireClientPageAccess:${MANDANT}`,
      'requireModulePage:staff:tcms',
    ]);
  });

  it('bildet Verweigerung und abgeschaltetes TCMS auf Zustände ab, anderes geht weiter', async () => {
    m.kanzleiAkteurTx.mockRejectedValueOnce(new TcmsAkteurVerweigert('SITZUNG_VERALTET'));
    expect(await tcmsMandantSeite(MANDANT)).toEqual({
      ok: false,
      zustand: { art: 'KEIN_ZUGRIFF', neuAnmelden: true },
    });
    m.assertAktiv.mockRejectedValueOnce(new TcmsInaktivError());
    expect(await tcmsMandantSeite(MANDANT)).toEqual({
      ok: false,
      zustand: { art: 'NICHT_KONFIGURIERT' },
    });
    m.kanzleiAkteurTx.mockRejectedValueOnce(new Error('DB weg'));
    await expect(tcmsMandantSeite(MANDANT)).rejects.toThrow('DB weg');
  });

  it('404 für ungültige IDs und Mandanten außerhalb des Tenants, bevor ein Akteur entsteht', async () => {
    await expect(tcmsMandantSeite('abc')).rejects.toThrow('NEXT_NOT_FOUND');
    m.tx.client.findFirst.mockResolvedValueOnce(null);
    await expect(tcmsMandantSeite(MANDANT)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(m.kanzleiAkteurTx).not.toHaveBeenCalled();
  });
});

describe('weitere Einstiege', () => {
  it('Kanzlei: Sitzung, Modul, Mandantenliste aus kanzleiMandantenListeTx', async () => {
    const seite = (await tcmsKanzleiSeite()) as TcmsKanzleiSeite;
    expect(m.reihenfolge).toEqual([
      'requireStaffPage:alle',
      'requireModulePage:staff:tcms',
      'tx:start',
      'assertTcmsAktivTx',
      'kanzleiMandantenListeTx',
      'tx:ende',
    ]);
    expect(seite).toMatchObject({ ok: true, art: 'KANZLEI', liste: LISTE, akteur: KANZLEI_AKTEUR });
  });

  it('Admin: nur Admin/Partner, Akteur ohne Mandantenbezug', async () => {
    const seite = await tcmsAdminSeite();
    expect(m.reihenfolge[0]).toBe('requireStaffPage:admin');
    expect(m.kanzleiAkteurTx).toHaveBeenCalledWith(m.tx, STAFF_SESSION);
    expect(seite).toMatchObject({ ok: true, art: 'ADMIN', akteur: KANZLEI_AKTEUR });
  });

  it('Portal: Mandant nur aus der Sitzung, Kontext des Kontakts', async () => {
    const seite = (await tcmsPortalSeite()) as TcmsPortalSeite;
    expect(m.reihenfolge.slice(0, 2)).toEqual(['portalAuth', 'requireModulePage:portal:tcms']);
    expect(m.kontexte).toEqual([
      { tenantId: TENANT, actorId: KONTAKT, actorType: 'CLIENT_CONTACT' },
    ]);
    expect(seite).toMatchObject({
      ok: true,
      art: 'PORTAL',
      mandantId: MANDANT,
      akteur: PORTAL_AKTEUR,
    });
  });
});

describe('tcmsLesen', () => {
  it('setzt Mandant und Akteur aus der Seite, außerhalb jeder Transaktion', async () => {
    const seite = await mandantSeite();
    m.reihenfolge.length = 0;
    const ergebnis = await tcmsLesen(seite, ENDPUNKTE.risikoLesen, {
      params: { risikoId: 'r-1', mandantId: FREMD } as never,
      query: { stand: '2026-10-01' } as never,
    });
    expect(ergebnis).toEqual({ ok: true, daten: { ok: 'daten' }, requestId: 'req-1' });
    expect(m.reihenfolge).toEqual(['rufeEndpunkt']);
    const [, endpunkt, eingabe] = m.rufe.mock.calls[0]!;
    expect(endpunkt).toBe(ENDPUNKTE.risikoLesen);
    // Ein mandantId-Parameter der Seite wird überschrieben, nie übernommen.
    expect(eingabe).toEqual({
      params: { risikoId: 'r-1', mandantId: MANDANT },
      query: { stand: '2026-10-01' },
      akteur: MANDANT_AKTEUR,
    });
  });

  it('Portfolio: Body ist immer die bestätigte Mandantenliste der Seite', async () => {
    const seite = (await tcmsKanzleiSeite()) as TcmsKanzleiSeite;
    await tcmsLesen(seite, ENDPUNKTE.portfolioLesen);
    expect(m.rufe.mock.calls[0]![2]).toEqual({ params: {}, body: LISTE, akteur: KANZLEI_AKTEUR });
  });

  it('weist falsche Kombinationen von Seite und Endpunkt als Programmierfehler ab', async () => {
    const mandant = await mandantSeite();
    const kanzlei = (await tcmsKanzleiSeite()) as TcmsKanzleiSeite;
    const portal = (await tcmsPortalSeite()) as TcmsPortalSeite;
    await expect(tcmsLesen(kanzlei, ENDPUNKTE.kontextLesen)).rejects.toThrow(
      /braucht eine Mandanten- oder Portalseite/,
    );
    await expect(tcmsLesen(mandant, ENDPUNKTE.portfolioLesen)).rejects.toThrow(
      /braucht tcmsKanzleiSeite/,
    );
    await expect(tcmsLesen(portal, ENDPUNKTE.kontextLesen)).rejects.toThrow(/kein Portal-Endpunkt/);
    await expect(tcmsLesen(mandant, ENDPUNKTE.mandantAnkerSetzen)).rejects.toThrow(/kein Lesepfad/);
    await expect(tcmsLesen(kanzlei, ENDPUNKTE.auditPruefen)).rejects.toThrow(/kein Lesepfad/);
    await expect(
      tcmsLesen(kanzlei, ENDPUNKTE.auditLesen, { params: { mandantId: MANDANT } as never }),
    ).rejects.toThrow(/keinen Mandanten im Pfad/);
    expect(m.rufe).not.toHaveBeenCalled();
  });

  it('404 → notFound() bzw. null (optional), 403 → kein Zugriff, Ausfall → nicht erreichbar', async () => {
    const seite = await mandantSeite();
    m.rufe.mockRejectedValueOnce(new TcmsNichtGefunden({ status: 404, requestId: 'r' }));
    await expect(tcmsLesen(seite, ENDPUNKTE.kontextLesen)).rejects.toThrow('NEXT_NOT_FOUND');
    m.rufe.mockRejectedValueOnce(new TcmsNichtGefunden({ status: 404, requestId: 'r' }));
    expect(await tcmsLesenOptional(seite, ENDPUNKTE.kontextLesen)).toEqual({
      ok: true,
      daten: null,
      requestId: 'r',
    });
    m.rufe.mockRejectedValueOnce(
      new TcmsNichtBerechtigt({ status: 403, meldung: 'Grund mit Namen Anna Roth' }),
    );
    expect(await tcmsLesen(seite, ENDPUNKTE.kontextLesen)).toEqual({
      ok: false,
      zustand: { art: 'KEIN_ZUGRIFF', neuAnmelden: false },
    });
    m.rufe.mockRejectedValueOnce(new TcmsNichtVerfuegbar('ZEITLIMIT', { requestId: 'req-7' }));
    expect(await tcmsLesen(seite, ENDPUNKTE.kontextLesen)).toEqual({
      ok: false,
      zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-7' },
    });
    expect(JSON.stringify(m.log.info.mock.calls)).not.toContain('Anna');
    m.rufe.mockRejectedValueOnce(new TypeError('kaputt'));
    await expect(tcmsLesen(seite, ENDPUNKTE.kontextLesen)).rejects.toThrow('kaputt');
  });
});

describe('tcmsNamenLesen', () => {
  it('Mandantenseite: Mitarbeiter des Tenants und Kontakte nur dieses Mandanten', async () => {
    const seite = await mandantSeite();
    m.tx.staffUser.findMany.mockResolvedValue([{ id: STAFF, fullName: ' Anna Roth ' }]);
    m.tx.clientContact.findMany.mockResolvedValue([{ id: KONTAKT, fullName: 'Kim Kontakt' }]);
    const namen = await tcmsNamenLesen(seite, [STAFF, KONTAKT, 'kein-uuid', null]);
    expect(namen.name(STAFF)).toBe('Anna Roth');
    expect(namen.name(KONTAKT)).toBe('Kim Kontakt');
    expect(namen.name(FREMD)).toBe('Unbekannte Person');
    expect(namen.name(null)).toBe('—');
    expect(m.tx.clientContact.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, clientId: MANDANT, id: { in: [STAFF, KONTAKT] } },
      select: { id: true, fullName: true },
    });
  });

  it('Kanzleiseite: keine Kontakte (kein Mandantenbezug)', async () => {
    const seite = (await tcmsKanzleiSeite()) as TcmsKanzleiSeite;
    m.tx.staffUser.findMany.mockResolvedValue([]);
    await tcmsNamenLesen(seite, [KONTAKT]);
    expect(m.tx.clientContact.findMany).not.toHaveBeenCalled();
  });
});
