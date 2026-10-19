// TCMS Stufe 3, Bereich C: Verdrahtung der Aktionen der Feststellungen.
// Ablauf, Gate und Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts;
// hier: Mandant und Objekt aus den gebundenen Argumenten, Prüfung der Eingaben
// nach dem Vertrag (ohne Dienstaufruf bei Fehlern), Personen über personen.ts,
// Endpunkt und Body.
// Fachkatalog: TCMS-AKTEUR-001
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsKonflikt, TcmsNichtVerfuegbar } from '@taxtronik/tcms-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  kanzlei: vi.fn(),
  kontakte: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));
vi.mock('@/server/tcms/personen', () => ({
  kanzleiPersonenFuerMandantTx: h.kanzlei,
  mandantKontakteTx: h.kontakte,
}));

import * as aktionen from '../actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const FID = 'cmvf9q0c40082fu7dh1ef2q31';
const K = { g: { tenantId: TENANT }, akteur: {}, mandantId: MANDANT };
const BEGRUENDUNG = 'Registrierungspflicht in CZ wird mit der Beraterin vor Ort geklärt.';

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: Record<string, string[]> };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function dienst(antwort: unknown = {}) {
  return {
    rufe: vi.fn(async (..._eingabe: unknown[]) => {
      if (antwort instanceof Error) throw antwort;
      return { daten: antwort, requestId: 'r' };
    }),
  };
}

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

function geparst(): unknown {
  const p = spec().parse!();
  expect(p, JSON.stringify(p.fieldErrors)).toMatchObject({ ok: true });
  return p.data;
}

function fehler(): Record<string, string[]> {
  const p = spec().parse!();
  expect(p.ok).toBe(false);
  return p.fieldErrors ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
});

describe('§-153-Würdigung', () => {
  it('ohne gewählte Option kein Dienstaufruf (keine Vorauswahl), Begründung ≥ 30 Zeichen', async () => {
    await aktionen.p153EntscheidenAction(MANDANT, FID, null, formular([['begruendung', 'kurz']]));
    expect(spec().keinRecht).toBe('WUERDIGEN');
    const fe = fehler();
    expect(fe.entscheidung).toEqual(['Bitte eine der vier Optionen wählen.']);
    expect(fe.begruendung).toBeDefined();
  });

  it('Body mit Entscheidung, Begründung, Frist und bisherigem Stand', async () => {
    await aktionen.p153EntscheidenAction(
      MANDANT,
      FID,
      null,
      formular([
        ['entscheidung', 'WEITERE_KLAERUNG'],
        ['begruendung', BEGRUENDUNG],
        ['frist', '2026-11-15'],
        ['bisher', ''],
      ]),
    );
    const d = dienst({ id: FID, entscheidung: 'WEITERE_KLAERUNG', wiedervorlageNr: 130 });
    await expect(spec().aufruf(d, geparst(), undefined)).resolves.toEqual({
      meldung: 'Entscheidung dokumentiert: Weitere Klärung · Wiedervorlage #130.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.p153Entscheiden, {
      params: { feststellungId: FID },
      body: {
        entscheidung: 'WEITERE_KLAERUNG',
        begruendung: BEGRUENDUNG,
        frist: '2026-11-15',
        bisher: null,
      },
    });
  });

  it('ohne Frist kein Fristfeld; bisheriger Stand wird mitgegeben', async () => {
    await aktionen.p153EntscheidenAction(
      MANDANT,
      FID,
      null,
      formular([
        ['entscheidung', 'KEINE_PFLICHT'],
        ['begruendung', BEGRUENDUNG],
        ['frist', ''],
        ['bisher', 'WEITERE_KLAERUNG'],
      ]),
    );
    const d = dienst({ id: FID, entscheidung: 'KEINE_PFLICHT', wiedervorlageNr: null });
    await spec().aufruf(d, geparst(), undefined);
    expect(d.rufe.mock.calls[0]![1]).toEqual({
      params: { feststellungId: FID },
      body: { entscheidung: 'KEINE_PFLICHT', begruendung: BEGRUENDUNG, bisher: 'WEITERE_KLAERUNG' },
    });
  });
});

describe('Weiterschalten, Verwerfen, Vertraulichkeit', () => {
  it('weiter: gesehener Status im Body; 409 mit eigenem Text', async () => {
    await aktionen.feststellungWeiterAction(
      MANDANT,
      FID,
      null,
      formular([['von', 'IN_WUERDIGUNG']]),
    );
    let d = dienst({ id: FID, nummer: 'F-2026-007', status: 'MASSNAHMEN_OFFEN' });
    await expect(spec().aufruf(d, geparst(), undefined)).resolves.toEqual({
      meldung: 'Status: Maßnahmen offen.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.feststellungWeiterschalten, {
      params: { feststellungId: FID },
      body: { von: 'IN_WUERDIGUNG' },
    });
    d = dienst(new TcmsKonflikt({ status: 409, meldung: 'Noch nicht möglich: Anna …' }));
    const r = (await spec().aufruf(d, geparst(), undefined)) as Record<string, string>;
    expect(r).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect(r.error).toMatch(
      /noch nicht möglich oder die Feststellung wurde zwischenzeitlich geändert/,
    );
    expect(r.error).not.toContain('Anna');
    // Andere Fehler gehen an die Abbildung des Helfers.
    const aus = new TcmsNichtVerfuegbar('ZEITLIMIT');
    await expect(spec().aufruf(dienst(aus), geparst(), undefined)).rejects.toBe(aus);
  });

  it('Verwerfen beantragen mit Begründung ≥ 30; bestätigen und ablehnen ohne Body', async () => {
    await aktionen.verwerfenBeantragenAction(
      MANDANT,
      FID,
      null,
      formular([['begruendung', 'kurz']]),
    );
    expect(fehler().begruendung).toBeDefined();
    await aktionen.verwerfenBeantragenAction(
      MANDANT,
      FID,
      null,
      formular([['begruendung', BEGRUENDUNG]]),
    );
    let d = dienst({ id: FID, nummer: 'F', status: 'IN_WUERDIGUNG' });
    await spec().aufruf(d, geparst(), undefined);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.feststellungVerwerfenBeantragen, {
      params: { feststellungId: FID },
      body: { begruendung: BEGRUENDUNG },
    });
    await aktionen.verwerfenBestaetigenAction(MANDANT, FID, null, formular([]));
    expect(spec().keinRecht).toBe('VERWERFEN_BESTAETIGEN');
    d = dienst({ id: FID, nummer: 'F', status: 'VERWORFEN' });
    await spec().aufruf(d, undefined, undefined);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.feststellungVerwerfenBestaetigen, {
      params: { feststellungId: FID },
    });
    await aktionen.verwerfenAblehnenAction(MANDANT, FID, null, formular([]));
    d = dienst({ id: FID, zurueckgezogen: true });
    await expect(spec().aufruf(d, undefined, undefined)).resolves.toEqual({
      meldung: 'Antrag zurückgezogen.',
    });
  });

  it('vertraulich: nur 0/1, Recht VERTRAULICH', async () => {
    await aktionen.vertraulichAction(MANDANT, FID, null, formular([['vertraulich', 'ja']]));
    expect(fehler().vertraulich).toBeDefined();
    await aktionen.vertraulichAction(MANDANT, FID, null, formular([['vertraulich', '1']]));
    expect(spec().keinRecht).toBe('VERTRAULICH');
    const d = dienst({ id: FID, vertraulich: true, geaendert: true });
    await expect(spec().aufruf(d, geparst(), undefined)).resolves.toEqual({
      meldung: 'Als vertraulich markiert – nur für Beteiligte sichtbar.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.feststellungVertraulichSetzen, {
      params: { feststellungId: FID },
      body: { vertraulich: true },
    });
  });

  it('ungültige gebundene Feststellung: kein Dienstaufruf', async () => {
    await aktionen.verwerfenBestaetigenAction(MANDANT, 'F-2026-007', null, formular([]));
    const d = dienst();
    await expect(spec().aufruf(d, undefined, undefined)).rejects.toThrow(
      'Feststellung nicht gefunden.',
    );
    expect(d.rufe).not.toHaveBeenCalled();
  });
});

describe('Maßnahmen', () => {
  it('Verantwortliche Kanzleiperson nur über kanzleiPersonenFuerMandantTx dieses Mandanten', async () => {
    const STAFF = 'b1000000-0000-4000-8000-000000000002';
    await aktionen.massnahmeAnlegenAction(
      MANDANT,
      FID,
      null,
      formular([
        ['beschreibung', 'Registrierung in CZ beauftragen'],
        ['verantwortlich', `KANZLEI:${STAFF.toUpperCase()}`],
        ['frist', '2026-11-30'],
        ['mandantId', 'a1000000-0000-4000-8000-000000004720'],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    h.kanzlei.mockResolvedValue([{ id: STAFF, name: 'Leon Brandt' }]);
    const v = await s.vorbereiten!({ tx: 1 }, K, geparst());
    expect(h.kanzlei).toHaveBeenCalledWith(
      { tx: 1 },
      { tenantId: TENANT, mandantId: MANDANT },
      [STAFF],
      {
        feld: 'verantwortlich',
      },
    );
    expect(h.kontakte).not.toHaveBeenCalled();
    const d = dienst({ id: 'm', wiedervorlageNr: 131 });
    await expect(s.aufruf(d, geparst(), v)).resolves.toEqual({
      meldung: 'Maßnahme angelegt · Wiedervorlage #131.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.massnahmeAnlegen, {
      params: { feststellungId: FID },
      body: {
        beschreibung: 'Registrierung in CZ beauftragen',
        verantwortlich: { id: STAFF, art: 'KANZLEI' },
        frist: '2026-11-30',
      },
    });
  });

  it('Verantwortlicher Kontakt nur über mandantKontakteTx; ungültiger Wert ohne Dienstaufruf', async () => {
    const KONTAKT = 'b1000000-0000-4000-8000-000000000011';
    await aktionen.massnahmeAnlegenAction(
      MANDANT,
      FID,
      null,
      formular([
        ['beschreibung', 'Verbringensmeldung nachholen'],
        ['verantwortlich', `MANDANT:${KONTAKT}`],
        ['frist', '2026-11-30'],
      ]),
    );
    h.kontakte.mockResolvedValue([{ id: KONTAKT, name: 'Jana', aktiv: true }]);
    await expect(spec().vorbereiten!({}, K, geparst())).resolves.toEqual({
      id: KONTAKT,
      art: 'MANDANT',
    });
    expect(h.kontakte).toHaveBeenCalledWith(
      {},
      { tenantId: TENANT, mandantId: MANDANT },
      [KONTAKT],
      {
        feld: 'verantwortlich',
      },
    );
    await aktionen.massnahmeAnlegenAction(
      MANDANT,
      FID,
      null,
      formular([
        ['beschreibung', 'Verbringensmeldung nachholen'],
        ['verantwortlich', KONTAKT],
        ['frist', '2026-11-30'],
      ]),
    );
    expect(fehler().verantwortlich).toEqual(['Bitte eine verantwortliche Person wählen.']);
  });

  it('erledigen: Nachweis ≥ 10 Zeichen, Maßnahme gebunden', async () => {
    await aktionen.massnahmeErledigenAction(
      MANDANT,
      'cmassnahme00000000001',
      null,
      formular([['nachweis', 'Beleg im DMS, Vorgang 4711.']]),
    );
    const d = dienst({ id: 'cmassnahme00000000001', wiedervorlageNr: 121 });
    await expect(spec().aufruf(d, geparst(), undefined)).resolves.toEqual({
      meldung: 'Maßnahme #121 erledigt.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.massnahmeErledigen, {
      params: { massnahmeId: 'cmassnahme00000000001' },
      body: { nachweis: 'Beleg im DMS, Vorgang 4711.' },
    });
  });
});

describe('Erfassen, Würdigung, Erklärung, Nachkontrolle', () => {
  it('erfassen: Durchführung nur bei Quelle Kontrolle, Risiken ohne Dubletten', async () => {
    const R = 'cmvf9pzjt000bfu7d577g29ub';
    const felder: Array<[string, string]> = [
      ['titel', 'Clearingkonto Klarna mit Restsaldo'],
      ['sachverhalt', 'Restsaldo zum Monatsende auf dem Klarna-Clearingkonto.'],
      ['quelle', 'HINWEIS'],
      ['quelleText', 'Hinweis Buchhaltung'],
      ['durchfuehrungId', 'cmvf9q02e005efu7dgfw846up'],
      ['klasse', 'DURCHFUEHRUNGSMANGEL'],
      ['schwere', 'GERING'],
      ['auswirkung', 'NEIN'],
      ['risiken', R],
      ['risiken', R],
    ];
    await aktionen.feststellungErfassenAction(MANDANT, null, formular(felder));
    expect(spec().keinRecht).toBe('BEARBEITEN');
    const daten = geparst() as Record<string, unknown>;
    expect(daten).not.toHaveProperty('durchfuehrungId');
    expect(daten.risikoIds).toEqual([R]);
    const d = dienst({
      id: 'f',
      nummer: 'F-2026-008',
      auswirkung: 'UNKLAR',
      auswirkungHerabgestuft: true,
    });
    await expect(spec().aufruf(d, daten, undefined)).resolves.toEqual({
      meldung:
        'Feststellung F-2026-008 erfasst. Die steuerliche Auswirkung „nein“ stufen nur Berufsträger:innen ein; sie ist als „unklar“ zur Würdigung erfasst.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.feststellungErfassen, { body: daten });

    felder[2] = ['quelle', 'KONTROLLE'];
    await aktionen.feststellungErfassenAction(MANDANT, null, formular(felder));
    expect(geparst()).toMatchObject({ durchfuehrungId: 'cmvf9q02e005efu7dgfw846up' });
  });

  it('Erklärung: deutscher Betrag, leer = zu klären, unlesbar = Feldfehler', async () => {
    const basis: Array<[string, string]> = [
      ['steuerart', 'USt (OSS)'],
      ['land', 'CZ'],
      ['zeitraum', 'Q3 2026'],
    ];
    await aktionen.erklaerungAction(
      MANDANT,
      FID,
      null,
      formular([...basis, ['auswirkungEur', '1.234,50']]),
    );
    expect(geparst()).toMatchObject({ auswirkungEur: 1234.5 });
    await aktionen.erklaerungAction(
      MANDANT,
      FID,
      null,
      formular([...basis, ['auswirkungEur', '']]),
    );
    expect(geparst()).toMatchObject({ auswirkungEur: null });
    await aktionen.erklaerungAction(
      MANDANT,
      FID,
      null,
      formular([...basis, ['auswirkungEur', 'viel']]),
    );
    expect(fehler().auswirkungEur).toEqual(['Die geschätzte Auswirkung ist keine Zahl.']);
  });

  it('Würdigung und Nachkontrolle: Body nach Vertrag', async () => {
    await aktionen.wuerdigungAction(
      MANDANT,
      FID,
      null,
      formular([
        ['schwere', 'HOCH'],
        ['auswirkung', 'JA'],
        ['ursache', ''],
      ]),
    );
    let d = dienst({ id: FID, nummer: 'F', status: 'IN_WUERDIGUNG' });
    await spec().aufruf(d, geparst(), undefined);
    expect(d.rufe.mock.calls[0]![1]).toEqual({
      params: { feststellungId: FID },
      body: { schwere: 'HOCH', auswirkung: 'JA', ursache: null },
    });
    await aktionen.nachkontrolleAction(
      MANDANT,
      FID,
      null,
      formular([
        ['kontrolleId', 'cmvf9pzqd001nfu7dv1wne7oy'],
        ['faelligAm', '2026-11-02'],
      ]),
    );
    d = dienst({ durchfuehrungId: 'neu', kontrolleCode: 'K-EC-04' });
    await expect(spec().aufruf(d, geparst(), undefined)).resolves.toEqual({
      meldung: 'Nachkontrolle K-EC-04 angelegt und verknüpft.',
    });
  });
});
