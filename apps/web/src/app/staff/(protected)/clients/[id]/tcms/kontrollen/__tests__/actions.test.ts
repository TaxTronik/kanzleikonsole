// TCMS Stufe 3, Bereich B: Verdrahtung der Aktionen der Kontrollmatrix
// (Designbeurteilung, Frequenzabweichung, Zuständigkeiten). Ablauf, Gate und
// Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts. Schwerpunkt:
// Personen aus dem Formular nur nach Prüfung in der kanzleikonsole – je nach
// Seite der Kontrolle Kanzleiperson oder Kontakt dieses Mandanten. Die Seite
// sendet die gelesene Seite (`partei`, TCMS s7) mit; weicht sie im Dienst ab,
// antwortet er 409 und die Aktion zeigt eine feste Meldung (kein Vorab-Read).
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import { TcmsKonflikt } from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
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
  TcmsPersonUnzulaessig: class extends Error {},
}));

import {
  frequenzAbweichungAufhebenAction,
  frequenzAbweichungBeantragenAction,
  frequenzAbweichungEntscheidenAction,
  kontrolleDesignBeurteilenAction,
  verantwortlicheAendernAction,
} from '../actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const FREMD = 'a1000000-0000-4000-8000-000000004720';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const ANNA = 'c1000000-0000-4000-8000-000000000001';
const LEON = 'c1000000-0000-4000-8000-000000000002';
const MURAT = 'c1000000-0000-4000-8000-000000000003';
const JANA = 'b1000000-0000-4000-8000-000000000011';
const TX = { tx: true };
const K = { g: { tenantId: TENANT }, akteur: {}, mandantId: MANDANT };
const BEZUG = { tenantId: TENANT, mandantId: MANDANT };
const BEGRUENDUNG = 'Monatliche Prüfung genügt wegen geringer Fallzahl im Halbjahr.';
const GEAENDERT = {
  frequenz: { turnus: 'QUARTALSWEISE', anlass: false },
  version: 3,
  neuplanung: { code: 'K-EC-08', angelegt: ['a'], entfernt: ['b', 'c'] },
};

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: Record<string, unknown> };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

/** Wie personen.ts: geprüfte IDs in der Form der Datenbank (klein geschrieben). */
function geprueft(ids: string[]) {
  return ids.map((id) => ({ id: id.toLowerCase(), name: 'Name', aktiv: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.kanzlei.mockImplementation(async (_tx, _bezug, ids: string[]) => geprueft(ids));
  h.kontakte.mockImplementation(async (_tx, _bezug, ids: string[]) => geprueft(ids));
});

describe('kontrolleDesignBeurteilenAction', () => {
  it('sendet Urteil, Stand und Begründung; Meldung mit neuer Version und Frequenz', async () => {
    await kontrolleDesignBeurteilenAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-02'],
        ['standId', 'ks_2'],
        ['design', 'MANGEL'],
        ['begruendung', BEGRUENDUNG],
        ['mandantId', FREMD],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    const parsed = s.parse!();
    const rufe = vi.fn(async () => ({ daten: GEAENDERT, requestId: 'r' }));
    const ergebnis = (await s.aufruf({ rufe }, parsed.data, undefined)) as { meldung: string };
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.kontrolleDesignBeurteilen, {
      params: { kontrolleId: 'K-EC-02' },
      body: { standId: 'ks_2', design: 'MANGEL', begruendung: BEGRUENDUNG },
    });
    expect(ergebnis.meldung).toContain('„Mangel“');
    expect(ergebnis.meldung).toContain('Neuer Kontrollstand v3');
    expect(ergebnis.meldung).toContain('(1 angelegt, 2 entfernt)');
  });

  it('ohne Wahl des Urteils: Feldfehler (keine Vorauswahl)', async () => {
    await kontrolleDesignBeurteilenAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-02'],
        ['standId', 'ks_2'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['design']);
  });
});

describe('Frequenzabweichung', () => {
  it('beantragt mit Turnus und Anlass-Haken', async () => {
    await frequenzAbweichungBeantragenAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-08'],
        ['standId', 'ks_8'],
        ['turnus', 'QUARTALSWEISE'],
        ['anlass', 'on'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    const s = spec();
    expect(s.keinRecht).toBe('BEARBEITEN');
    const rufe = vi.fn(async () => ({ daten: GEAENDERT, requestId: 'r' }));
    const ergebnis = (await s.aufruf({ rufe }, s.parse!().data, undefined)) as { meldung: string };
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.frequenzAbweichungBeantragen, {
      params: { kontrolleId: 'K-EC-08' },
      body: { standId: 'ks_8', turnus: 'QUARTALSWEISE', anlass: true, begruendung: BEGRUENDUNG },
    });
    expect(ergebnis.meldung).toContain('zweite Person');
  });

  it('Entscheidung: „zweite Person“ bei 403; Ablehnung nur mit Begründung', async () => {
    await frequenzAbweichungEntscheidenAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-08'],
        ['standId', 'ks_8'],
        ['entscheidung', 'ABLEHNEN'],
        ['begruendung', ''],
      ]),
    );
    expect(spec().keinRecht).toBe('VIER_AUGEN');
    const abgelehnt = spec().parse!();
    expect(abgelehnt.ok).toBe(false);
    expect(Object.keys(abgelehnt.fieldErrors ?? {})).toEqual(['begruendung']);

    await frequenzAbweichungEntscheidenAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-08'],
        ['standId', 'ks_8'],
        ['entscheidung', 'FREIGEBEN'],
      ]),
    );
    const s = spec();
    const rufe = vi.fn(async () => ({ daten: GEAENDERT, requestId: 'r' }));
    await s.aufruf({ rufe }, s.parse!().data, undefined);
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.frequenzAbweichungEntscheiden, {
      params: { kontrolleId: 'K-EC-08' },
      body: { standId: 'ks_8', entscheidung: 'FREIGEBEN' },
    });
  });

  it('hebt mit Begründung auf', async () => {
    await frequenzAbweichungAufhebenAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-08'],
        ['standId', 'ks_8'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    const s = spec();
    expect(s.keinRecht).toBe('BEARBEITEN');
    const rufe = vi.fn(async () => ({ daten: { ...GEAENDERT, neuplanung: null }, requestId: 'r' }));
    const ergebnis = (await s.aufruf({ rufe }, s.parse!().data, undefined)) as { meldung: string };
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.frequenzAbweichungAufheben, {
      params: { kontrolleId: 'K-EC-08' },
      body: { standId: 'ks_8', begruendung: BEGRUENDUNG },
    });
    expect(ergebnis.meldung).not.toContain('neu geplant');
  });
});

describe('verantwortlicheAendernAction', () => {
  function zustaendigkeit(partei: string, extra: Array<[string, string]> = []) {
    return formular([
      ['kontrolleId', 'K-EC-02'],
      ['standId', 'ks_2'],
      ['partei', partei],
      // Großschreibung: in den Body gehen die von der kanzleikonsole bestätigten IDs.
      ['durchfuehrendId', LEON.toUpperCase()],
      ['vertretungId', MURAT],
      ['gegenzeichnerId', ANNA],
      ['mandantId', FREMD],
      ...extra,
    ]);
  }

  /** Dienst, der das Ergebnis der Änderung liefert. */
  function dienst() {
    return { rufe: vi.fn(async () => ({ daten: GEAENDERT, requestId: 'r' })) };
  }

  it('Kanzleiseite: alle Personen als Kanzleipersonen mit Zugriff auf diesen Mandanten', async () => {
    await verantwortlicheAendernAction(MANDANT, null, zustaendigkeit('KANZLEI'));
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    const parsed = s.parse!();
    const personen = await s.vorbereiten!(TX, K, parsed.data);
    expect(h.kanzlei.mock.calls).toEqual([
      [TX, BEZUG, [LEON.toUpperCase()], { feld: 'durchfuehrendId' }],
      [TX, BEZUG, [MURAT], { feld: 'vertretungId' }],
      [TX, BEZUG, [ANNA], { feld: 'gegenzeichnerId' }],
    ]);
    expect(h.kontakte).not.toHaveBeenCalled();

    const d = dienst();
    await s.aufruf(d, parsed.data, personen);
    // Ein Aufruf: die Seite kommt aus der gelesenen Antwort, kein Vorab-Read.
    expect(d.rufe).toHaveBeenCalledTimes(1);
    expect(d.rufe.mock.calls[0]).toEqual([
      ENDPUNKTE.verantwortlicheAendern,
      {
        params: { kontrolleId: 'K-EC-02' },
        body: {
          standId: 'ks_2',
          partei: 'KANZLEI',
          durchfuehrendId: LEON,
          vertretungId: MURAT,
          gegenzeichnerId: ANNA,
          gegenzeichnungMandant: false,
        },
      },
    ]);
  });

  it('Mandantenseite: Durchführende und Vertretung als Kontakte dieses Mandanten, Gegenzeichnung in der Kanzlei', async () => {
    await verantwortlicheAendernAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-08'],
        ['standId', 'ks_8'],
        ['partei', 'MANDANT'],
        ['durchfuehrendId', JANA],
        ['vertretungId', JANA],
        ['gegenzeichnerId', ANNA],
      ]),
    );
    const s = spec();
    const parsed = s.parse!();
    await s.vorbereiten!(TX, K, parsed.data);
    expect(h.kontakte.mock.calls).toEqual([
      [TX, BEZUG, [JANA], { feld: 'durchfuehrendId' }],
      [TX, BEZUG, [JANA], { feld: 'vertretungId' }],
    ]);
    expect(h.kanzlei.mock.calls).toEqual([[TX, BEZUG, [ANNA], { feld: 'gegenzeichnerId' }]]);
  });

  it('Gegenzeichnung beim Mandanten: keine gegenzeichnende Person, auch wenn das Formular eine sendet', async () => {
    await verantwortlicheAendernAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-23'],
        ['standId', 'ks_23'],
        ['partei', 'MANDANT'],
        ['durchfuehrendId', JANA],
        ['vertretungId', JANA],
        ['gegenzeichnerId', ANNA],
        ['gegenzeichnungMandant', 'on'],
      ]),
    );
    const s = spec();
    const parsed = s.parse!();
    const personen = await s.vorbereiten!(TX, K, parsed.data);
    expect(h.kanzlei).not.toHaveBeenCalled();
    expect(personen).toEqual({ durchfuehrendId: JANA, vertretungId: JANA, gegenzeichnerId: null });
    const d = dienst();
    await s.aufruf(d, parsed.data, personen);
    expect((d.rufe.mock.calls[0] as unknown[])[1]).toMatchObject({
      body: { partei: 'MANDANT', gegenzeichnerId: null, gegenzeichnungMandant: true },
    });
  });

  it('Kanzleiseite mit Haken „beim Mandanten“: Feldfehler, kein Dienstaufruf (400 des Vertrags)', async () => {
    // Die Seite bietet den Haken nur an Kontrollen des Mandanten an
    // (zustaendigkeit.test.tsx); ein manipuliertes Formular scheitert hier.
    await verantwortlicheAendernAction(
      MANDANT,
      null,
      zustaendigkeit('KANZLEI', [['gegenzeichnungMandant', 'on']]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['gegenzeichnungMandant']);
  });

  it('409 (Seite oder Stand im Dienst abweichend): feste Meldung, kein zweiter Aufruf', async () => {
    // Manipuliertes Formular: Kontakt des Mandanten als „Kanzlei“ geprüft, die
    // Kontrolle ist im Dienst eine Mandantenkontrolle – der Dienst weist ab.
    await verantwortlicheAendernAction(MANDANT, null, zustaendigkeit('KANZLEI'));
    const s = spec();
    const parsed = s.parse!();
    const personen = await s.vorbereiten!(TX, K, parsed.data);
    const rufe = vi.fn(async () => {
      throw new TcmsKonflikt({
        status: 409,
        code: 'KONFLIKT',
        requestId: 'r',
        meldung: 'Rohtext des Dienstes',
      });
    });
    const ergebnis = await s.aufruf({ rufe }, parsed.data, personen);
    expect(ergebnis).toEqual({
      ok: false,
      error:
        'Die Kontrolle wurde zwischenzeitlich geändert. Bitte laden Sie die Seite neu und prüfen Sie die Zuständigkeiten.',
      errorCode: 'CONFLICT',
    });
    expect(JSON.stringify(ergebnis)).not.toContain('Rohtext');
    expect(rufe).toHaveBeenCalledTimes(1);
  });

  it('andere Fehler des Dienstes gehen an die gemeinsame Abbildung', async () => {
    await verantwortlicheAendernAction(MANDANT, null, zustaendigkeit('KANZLEI'));
    const s = spec();
    const fehler = new Error('anders');
    const rufe = vi.fn(async () => {
      throw fehler;
    });
    await expect(s.aufruf({ rufe }, s.parse!().data, {})).rejects.toBe(fehler);
  });

  it('eine unzulässige Person beendet die Aktion vor dem Dienstaufruf', async () => {
    const fehler = new Error('unzulässig');
    h.kanzlei.mockRejectedValueOnce(fehler);
    await verantwortlicheAendernAction(MANDANT, null, zustaendigkeit('KANZLEI'));
    const s = spec();
    await expect(s.vorbereiten!(TX, K, s.parse!().data)).rejects.toBe(fehler);
  });

  it('weist fehlende Seite und Personen ohne UUID-Form als Feldfehler ab', async () => {
    await verantwortlicheAendernAction(
      MANDANT,
      null,
      formular([
        ['kontrolleId', 'K-EC-02'],
        ['standId', 'ks_2'],
        ['partei', 'BEIDE'],
        ['durchfuehrendId', 'leon'],
        ['vertretungId', ''],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {}).sort()).toEqual([
      'durchfuehrendId',
      'partei',
      'vertretungId',
    ]);
  });
});
