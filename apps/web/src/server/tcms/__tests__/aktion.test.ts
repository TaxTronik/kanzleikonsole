// TCMS Stufe 3: Aktions-Helfer (server/tcms/aktion.ts) mit dem echten
// Ablauf von staffAction/portalAction (createActionRunner), gebunden an ein
// gemocktes Gate. Geprüft: Gate-Optionen, Akteur und Vorbereitung in einer
// Transaktion, Dienstaufruf danach, Bindung von Mandant und Akteur,
// Revalidierung nur des TCMS-Bereichs, Fehlerabbildung.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  reihenfolge: [] as string[],
  guardOptionen: [] as unknown[],
  guardErgebnis: null as null | { ok: false; error: string },
  rufe: vi.fn(),
  kanzleiAkteurTx: vi.fn(),
  portalAkteurTx: vi.fn(),
  revalidate: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  tx: { marker: 'tx' },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => {
    m.reihenfolge.push(`revalidate:${args.join(',')}`);
    m.revalidate(...args);
  },
}));
vi.mock('@/server/actions/staff-action', async () => {
  const { createActionRunner } = await import('@/server/actions/action-runner');
  return {
    staffAction: createActionRunner(async (opts?: unknown) => {
      m.guardOptionen.push(opts);
      if (m.guardErgebnis) return m.guardErgebnis;
      return { ok: true, session: STAFF_SESSION, ctx: STAFF_CTX, tenantId: TENANT, staffId: STAFF };
    }),
  };
});
vi.mock('@/server/actions/portal-action', async () => {
  const { createActionRunner } = await import('@/server/actions/action-runner');
  return {
    portalAction: createActionRunner(async (opts?: unknown) => {
      m.guardOptionen.push(opts);
      return {
        ok: true,
        session: PORTAL_SESSION,
        ctx: PORTAL_CTX,
        tenantId: TENANT,
        contactId: KONTAKT,
        clientId: MANDANT,
      };
    }),
  };
});
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    m.reihenfolge.push(`tx:start:${(ctx as { actorType: string }).actorType}`);
    try {
      return await fn(m.tx);
    } finally {
      m.reihenfolge.push('tx:ende');
    }
  },
}));
vi.mock('../dienst', async (original) => ({
  ...(await original<typeof import('../dienst')>()),
  tcmsClient: () => ({ client: true }),
  assertTcmsAktivTx: async () => {
    m.reihenfolge.push('assertTcmsAktivTx');
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

import { TcmsKonflikt, TcmsNichtBerechtigt, TcmsNichtVerfuegbar } from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsAkteurVerweigert } from '../akteur';
import { tcmsKanzleiAktion, tcmsPortalAktion } from '../aktion';
import { TCMS_AKTION_TEXTE, TCMS_KEIN_RECHT } from '../zustand';

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const MANDANT = '33333333-3333-4333-8333-333333333333';
const FREMD = '44444444-4444-4444-8444-444444444444';
const KONTAKT = '55555555-5555-4555-8555-555555555555';
const STAFF_SESSION = { user: { tenantId: TENANT, staffId: STAFF } };
const STAFF_CTX = { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' };
const PORTAL_SESSION = { user: { tenantId: TENANT, contactId: KONTAKT, clientId: MANDANT } };
const PORTAL_CTX = { tenantId: TENANT, actorId: KONTAKT, actorType: 'CLIENT_CONTACT' };
const AKTEUR = {
  tnt: TENANT,
  sub: STAFF,
  knd: 'KANZLEI',
  nam: 'Anna',
  cli: { id: MANDANT, bt: true, hb: false },
};
const PORTAL_AKTEUR = {
  tnt: TENANT,
  sub: KONTAKT,
  knd: 'MANDANT',
  nam: 'Kim',
  cli: { id: MANDANT, bt: false, hb: false },
};
const ANKER = { name: 'Talwind GmbH', rechtsform: 'GmbH', datevNr: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.reihenfolge.length = 0;
  m.guardOptionen.length = 0;
  m.guardErgebnis = null;
  m.kanzleiAkteurTx.mockResolvedValue(AKTEUR);
  m.portalAkteurTx.mockResolvedValue(PORTAL_AKTEUR);
  m.rufe.mockResolvedValue({
    daten: { angelegt: true, geaendert: true },
    requestId: 'r',
    status: 200,
  });
});

function ankerAktion(mandantId: string | null = MANDANT) {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    vorbereiten: async (tx, k) => {
      m.reihenfolge.push('vorbereiten');
      expect(tx).toBe(m.tx);
      expect(k.akteur).toBe(AKTEUR);
      return ANKER;
    },
    aufruf: async (dienst, _daten, anker) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.mandantAnkerSetzen, { body: anker });
      return { angelegt: daten.angelegt };
    },
  });
}

describe('tcmsKanzleiAktion', () => {
  it('Gate mit Modul tcms, Akteur und Vorbereitung in einer Transaktion, Aufruf danach', async () => {
    const ergebnis = await ankerAktion();
    expect(ergebnis).toEqual({ ok: true, angelegt: true });
    expect(m.guardOptionen).toEqual([{ module: 'tcms' }]);
    expect(m.reihenfolge).toEqual([
      'tx:start:STAFF',
      'assertTcmsAktivTx',
      'kanzleiAkteurTx',
      'vorbereiten',
      'tx:ende',
      'rufeEndpunkt',
      `revalidate:/staff/clients/${MANDANT}/tcms,layout`,
      'revalidate:/staff/tcms,layout',
    ]);
    expect(m.kanzleiAkteurTx).toHaveBeenCalledWith(m.tx, STAFF_SESSION, { mandantId: MANDANT });
    expect(m.rufe.mock.calls[0]![1]).toBe(ENDPUNKTE.mandantAnkerSetzen);
    expect(m.rufe.mock.calls[0]![2]).toEqual({
      params: { mandantId: MANDANT },
      body: ANKER,
      akteur: AKTEUR,
    });
  });

  it('Mandant und Akteur kommen aus der Aktion, nicht aus der Eingabe', async () => {
    await tcmsKanzleiAktion({
      mandantId: MANDANT,
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.risikoLesen, {
          params: { risikoId: 'r1', mandantId: FREMD } as never,
        });
      },
    });
    expect(m.rufe.mock.calls[0]![2]).toEqual({
      params: { risikoId: 'r1', mandantId: MANDANT },
      akteur: AKTEUR,
    });
  });

  it('nurAdmin setzt requireAdmin am Gate; ohne Mandant nur kanzleiweite Endpunkte', async () => {
    await tcmsKanzleiAktion({
      mandantId: null,
      nurAdmin: true,
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.auditPruefen, { body: {} });
      },
    });
    expect(m.guardOptionen).toEqual([{ module: 'tcms', requireAdmin: true }]);
    expect(m.kanzleiAkteurTx).toHaveBeenCalledWith(m.tx, STAFF_SESSION, {});
    expect(m.revalidate).toHaveBeenCalledWith('/staff/tcms', 'layout');
    const falsch = await tcmsKanzleiAktion({
      mandantId: null,
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.mandantAnkerSetzen, { body: ANKER });
      },
    });
    expect(falsch.ok).toBe(false);
    const auchFalsch = await tcmsKanzleiAktion({
      mandantId: MANDANT,
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.portfolioLesen, { body: { mandantIds: [] } });
      },
    });
    expect(auchFalsch.ok).toBe(false);
    // Portfolio/Arbeitskorb sind Lesepfade mit der bestätigten Mandantenliste
    // der Seite (tcmsLesen); eine Aktion könnte sonst eine eigene Liste senden.
    const liste = await tcmsKanzleiAktion({
      mandantId: null,
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.portfolioLesen, { body: { mandantIds: [] } });
      },
    });
    expect(liste.ok).toBe(false);
    expect(m.rufe).toHaveBeenCalledTimes(1);
  });

  it('Gate-Ablehnung: kein Akteur, kein Aufruf', async () => {
    m.guardErgebnis = { ok: false, error: 'Modul tcms ist deaktiviert.' };
    expect(await ankerAktion()).toEqual({ ok: false, error: 'Modul tcms ist deaktiviert.' });
    expect(m.reihenfolge).toEqual([]);
  });

  it('Verweigerung des Akteurs: kein Aufruf, feste Meldung', async () => {
    m.kanzleiAkteurTx.mockRejectedValueOnce(new TcmsAkteurVerweigert('KEIN_MANDANTENZUGRIFF'));
    expect(await ankerAktion()).toEqual({
      ok: false,
      error: 'Kein Zugriff auf das Tax-CMS.',
      errorCode: 'FORBIDDEN',
    });
    expect(m.rufe).not.toHaveBeenCalled();
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it('bildet Antworten des Dienstes ab und revalidiert dann nicht', async () => {
    m.rufe.mockRejectedValueOnce(
      new TcmsNichtBerechtigt({ status: 403, meldung: 'Anna Roth darf nicht' }),
    );
    expect(await ankerAktion()).toEqual({
      ok: false,
      error: TCMS_KEIN_RECHT.BEARBEITEN,
      errorCode: 'FORBIDDEN',
    });
    m.rufe.mockRejectedValueOnce(new TcmsKonflikt({ status: 409 }));
    expect((await ankerAktion()).error).toBe('Wurde zwischenzeitlich geändert – bitte neu laden.');
    m.rufe.mockRejectedValueOnce(new TcmsNichtVerfuegbar('ZEITLIMIT'));
    expect((await ankerAktion()).error).toBe(TCMS_AKTION_TEXTE.unklar);
    expect(m.revalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(m.log.info.mock.calls)).toContain('mandantAnkerSetzen');
    expect(JSON.stringify([...m.log.info.mock.calls, ...m.log.warn.mock.calls])).not.toContain(
      'Anna',
    );
  });

  it('ein zurückgegebenes Fehlerergebnis geht unverändert zurück, ohne Revalidierung', async () => {
    const ergebnis = await tcmsKanzleiAktion({
      mandantId: MANDANT,
      aufruf: async () => ({ ok: false as const, error: 'Eigene Prüfung' }),
    });
    expect(ergebnis).toEqual({ ok: false, error: 'Eigene Prüfung' });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it('Feldfehler aus parse gehen vor jedem Akteur zurück', async () => {
    const ergebnis = await tcmsKanzleiAktion({
      mandantId: MANDANT,
      parse: () => ({
        ok: false,
        error: 'Bitte prüfen Sie die markierten Angaben.',
        errorCode: 'VALIDATION_ERROR',
        fieldErrors: { funktion: ['Höchstens 200 Zeichen.'] },
      }),
      aufruf: async () => undefined,
    });
    expect(ergebnis.fieldErrors).toEqual({ funktion: ['Höchstens 200 Zeichen.'] });
    expect(m.kanzleiAkteurTx).not.toHaveBeenCalled();
  });
});

describe('tcmsPortalAktion', () => {
  it('Mandant nur aus der Sitzung, nur Portal-Endpunkte, Revalidierung des Portals', async () => {
    const ergebnis = await tcmsPortalAktion({
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.portalAufgabeEinreichen, {
          params: { durchfuehrungId: 'd1' },
        });
        return { eingereicht: true };
      },
    });
    expect(ergebnis).toEqual({ ok: true, eingereicht: true });
    expect(m.guardOptionen).toEqual([{ module: 'tcms' }]);
    expect(m.reihenfolge).toEqual([
      'tx:start:CLIENT_CONTACT',
      'assertTcmsAktivTx',
      'portalAkteurTx',
      'tx:ende',
      'rufeEndpunkt',
      'revalidate:/portal/tcms,layout',
    ]);
    expect(m.rufe.mock.calls[0]![2]).toEqual({
      params: { durchfuehrungId: 'd1', mandantId: MANDANT },
      akteur: PORTAL_AKTEUR,
    });
  });

  it('weist Kanzlei-Endpunkte ab, bevor gesendet wird', async () => {
    const ergebnis = await tcmsPortalAktion({
      aufruf: async (dienst) => {
        await dienst.rufe(ENDPUNKTE.mandantAnkerSetzen, { body: ANKER });
      },
    });
    expect(ergebnis.ok).toBe(false);
    expect(m.rufe).not.toHaveBeenCalled();
  });
});
