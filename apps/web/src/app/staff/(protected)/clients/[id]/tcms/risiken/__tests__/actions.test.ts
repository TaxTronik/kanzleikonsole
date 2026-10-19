// TCMS Stufe 3, Bereich B: Verdrahtung der Aktionen des Risikoinventars.
// Ablauf, Gate und Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts;
// hier geht es darum, was die Aktion dem Helfer übergibt: Mandant aus dem
// gebundenen Argument, fester Text bei fehlendem Recht, Feldprüfung, Body und
// Endpunkt des Dienstaufrufs, Empfängerin der Risikoakzeptanz aus der
// kanzleikonsole.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  kontakte: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));
vi.mock('@/server/tcms/personen', () => ({ mandantKontakteTx: h.kontakte }));

import {
  risikenFreigabeSchrittAction,
  risikoakzeptanzAnfordernAction,
  risikoBewertungBestaetigenAction,
  risikoNeuBewertenAction,
  risikoZurueckweisenAction,
  uebersteuerungBeantragenAction,
  uebersteuerungEntscheidenAction,
} from '../actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const FREMD = 'a1000000-0000-4000-8000-000000004720';
const KONTAKT = 'b1000000-0000-4000-8000-000000000011';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const TX = { tx: true };
const K = { g: { tenantId: TENANT }, akteur: {}, mandantId: MANDANT };
const BEGRUENDUNG = 'Neue Plattformdaten zeigen höhere Umsätze in Frankreich als geplant.';

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: Record<string, unknown> };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function dienst(antwort: unknown = {}) {
  const rufe = vi.fn(async (..._args: unknown[]) => ({ daten: antwort, requestId: 'r' }));
  return { rufe };
}

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

/** Spec parsen, Dienst rufen, Aufruf und Ergebnis zurückgeben. */
async function ausfuehren(antwort: unknown, vorbereitet?: unknown) {
  const s = spec();
  const parsed = s.parse!();
  expect(parsed.ok).toBe(true);
  const d = dienst(antwort);
  const ergebnis = await s.aufruf(d, parsed.data, vorbereitet);
  return { d, ergebnis, data: parsed.data };
}

const NEU_BEWERTET = {
  code: 'EC-UST-01',
  geaendert: true,
  brutto: { vorher: 'MITTEL', nachher: 'HOCH' },
  freigabe: { vorher: 'FREIGEGEBEN', nachher: 'BEWERTET' },
  frequenzHinweise: [],
  neuplanungen: [{ code: 'K-EC-02', angelegt: ['a', 'b'], entfernt: ['c'] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  // Wie mandantKontakteTx: IDs in der Form der Datenbank (klein geschrieben).
  h.kontakte.mockImplementation(async (_tx, _bezug, ids: string[]) =>
    ids.map((id) => ({ id: id.toLowerCase(), name: 'Jana Weller', aktiv: true })),
  );
});

describe('risikoNeuBewertenAction', () => {
  it('sendet Bewertung und Begründung an den Dienst; Mandant aus dem gebundenen Argument', async () => {
    await risikoNeuBewertenAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        ['standId', 'st_1'],
        ['s', 'H'],
        ['w', 'MOEGLICH'],
        ['r', '2'],
        ['gt', 'FP'],
        ['begruendung', `  ${BEGRUENDUNG}  `],
        ['mandantId', FREMD],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.vorbereiten).toBeUndefined();
    const { d, ergebnis } = await ausfuehren(NEU_BEWERTET);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.risikoNeuBewerten, {
      params: { risikoId: 'EC-UST-01' },
      body: { standId: 'st_1', s: 'H', w: 'MOEGLICH', r: 2, gt: 'FP', begruendung: BEGRUENDUNG },
    });
    const meldung = (ergebnis as { meldung: string }).meldung;
    expect(meldung).toContain('EC-UST-01 neu bewertet: Brutto mittel → hoch.');
    expect(meldung).toContain('zweite Person');
    expect(meldung).toContain('K-EC-02 neu geplant (2 angelegt, 1 entfernt).');
  });

  it('weist zu kurze Begründung, unbekannte Werte und fremde IDs als Feldfehler ab', async () => {
    await risikoNeuBewertenAction(
      MANDANT,
      null,
      formular([
        ['risikoId', '../risiken'],
        ['standId', 'st_1'],
        ['s', 'RIESIG'],
        ['w', 'MOEGLICH'],
        ['r', '4'],
        ['gt', 'XX'],
        ['begruendung', 'zu kurz'],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {}).sort()).toEqual([
      'begruendung',
      'gt',
      'r',
      'risikoId',
      's',
    ]);
  });
});

describe('risikoBewertungBestaetigenAction', () => {
  it('bestätigt mit Stand und Begründung; Meldung „unverändert“', async () => {
    await risikoBewertungBestaetigenAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        ['standId', 'st_1'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    expect(spec().keinRecht).toBe('BEARBEITEN');
    const { d, ergebnis } = await ausfuehren({
      ...NEU_BEWERTET,
      geaendert: false,
      neuplanungen: [],
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.risikoBewertungBestaetigen, {
      params: { risikoId: 'EC-UST-01' },
      body: { standId: 'st_1', begruendung: BEGRUENDUNG },
    });
    expect((ergebnis as { meldung: string }).meldung).toBe(
      'EC-UST-01: Bewertung unverändert bestätigt.',
    );
  });
});

describe('Übersteuerung', () => {
  it('beantragt mit Sicht, Klasse und Begründung; die Meldung nennt die zweite Person', async () => {
    await uebersteuerungBeantragenAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        ['sicht', 'BETRIEB'],
        ['klasse', 'MITTEL'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    expect(spec().keinRecht).toBe('BEARBEITEN');
    const { d, ergebnis } = await ausfuehren({
      sicht: 'BETRIEB',
      berechnet: 'HOCH',
      klasse: 'MITTEL',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.uebersteuerungBeantragen, {
      params: { risikoId: 'EC-UST-01' },
      body: { sicht: 'BETRIEB', klasse: 'MITTEL', begruendung: BEGRUENDUNG },
    });
    expect((ergebnis as { meldung: string }).meldung).toBe(
      'Übersteuerung beantragt (Netto Betrieb: hoch → mittel). Sie gilt erst nach Freigabe durch eine zweite Person.',
    );
  });

  it('Entscheidung: fester Text „zweite Person“ bei 403, Freigabe ohne Begründung', async () => {
    await uebersteuerungEntscheidenAction(
      MANDANT,
      null,
      formular([
        ['uebersteuerungId', 'ue_1'],
        ['entscheidung', 'FREIGEBEN'],
        ['begruendung', ''],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('VIER_AUGEN');
    const { d, ergebnis } = await ausfuehren({ status: 'FREIGEGEBEN' });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.uebersteuerungEntscheiden, {
      params: { uebersteuerungId: 'ue_1' },
      body: { entscheidung: 'FREIGEBEN' },
    });
    expect((ergebnis as { meldung: string }).meldung).toContain('freigegeben');
  });

  it('Ablehnung braucht eine Begründung (Feldfehler wie im Vertrag)', async () => {
    await uebersteuerungEntscheidenAction(
      MANDANT,
      null,
      formular([
        ['uebersteuerungId', 'ue_1'],
        ['entscheidung', 'ABLEHNEN'],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['begruendung']);

    await uebersteuerungEntscheidenAction(
      MANDANT,
      null,
      formular([
        ['uebersteuerungId', 'ue_1'],
        ['entscheidung', 'ABLEHNEN'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    const { d } = await ausfuehren({ status: 'ABGELEHNT' });
    expect(d.rufe.mock.calls[0]![1]).toEqual({
      params: { uebersteuerungId: 'ue_1' },
      body: { entscheidung: 'ABLEHNEN', begruendung: BEGRUENDUNG },
    });
  });
});

describe('risikenFreigabeSchrittAction', () => {
  it.each([
    ['einreichen', 'BEARBEITEN', ENDPUNKTE.risikenFreigabeEinreichen, 'zur Freigabe eingereicht'],
    ['freigeben', 'VIER_AUGEN', ENDPUNKTE.risikenFreigeben, 'freigegeben'],
  ] as const)(
    'Schritt %s: Text bei 403 %s, Endpunkt nach Schritt, Auswahl ohne Dubletten',
    async (schritt, keinRecht, endpunkt, was) => {
      await risikenFreigabeSchrittAction(
        MANDANT,
        null,
        formular([
          ['schritt', schritt],
          ['risikoIds', 'EC-UST-01'],
          ['risikoIds', 'EC-UST-02'],
          ['risikoIds', 'EC-UST-01'],
        ]),
      );
      const s = spec();
      expect(s.mandantId).toBe(MANDANT);
      expect(s.keinRecht).toBe(keinRecht);
      const { d, ergebnis } = await ausfuehren({
        bearbeitet: [{ code: 'EC-UST-01' }],
        uebersprungen: [{ code: 'EC-UST-02', grund: 'selbst eingereicht' }],
      });
      expect(d.rufe).toHaveBeenCalledWith(endpunkt, {
        body: { risikoIds: ['EC-UST-01', 'EC-UST-02'] },
      });
      expect((ergebnis as { meldung: string }).meldung).toBe(
        `EC-UST-01 ${was}. Übersprungen: EC-UST-02 (selbst eingereicht).`,
      );
    },
  );

  it('ohne Auswahl, mit unbekanntem Schritt oder fremder ID: Feldfehler, kein Aufruf', async () => {
    await risikenFreigabeSchrittAction(MANDANT, null, formular([['schritt', 'freigeben']]));
    let parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['risikoIds']);

    await risikenFreigabeSchrittAction(
      MANDANT,
      null,
      formular([
        ['schritt', 'loeschen'],
        ['risikoIds', 'EC UST'],
      ]),
    );
    // Unbekannter Schritt: der allgemeine Text, nicht „zweite Person“.
    expect(spec().keinRecht).toBe('BEARBEITEN');
    parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {}).sort()).toEqual(['risikoIds', 'schritt']);
  });

  it('begrenzt die Auswahl wie der Vertrag (höchstens 200 Risiken)', async () => {
    const felder: Array<[string, string]> = [['schritt', 'einreichen']];
    for (let i = 0; i < 201; i++) felder.push(['risikoIds', `R-${i}`]);
    await risikenFreigabeSchrittAction(MANDANT, null, formular(felder));
    expect(spec().parse!().ok).toBe(false);
  });
});

describe('risikoZurueckweisenAction', () => {
  it('weist mit Begründung zurück; fester Text „zweite Person“ bei 403', async () => {
    await risikoZurueckweisenAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    expect(spec().keinRecht).toBe('VIER_AUGEN');
    const { d, ergebnis } = await ausfuehren({ code: 'EC-UST-01' });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.risikoZurueckweisen, {
      params: { risikoId: 'EC-UST-01' },
      body: { begruendung: BEGRUENDUNG },
    });
    expect((ergebnis as { meldung: string }).meldung).toContain('EC-UST-01 zurückgewiesen');
  });
});

describe('risikoakzeptanzAnfordernAction', () => {
  it('prüft die Empfängerin als aktiven Kontakt genau dieses Mandanten; Name aus der kanzleikonsole', async () => {
    await risikoakzeptanzAnfordernAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        // Großschreibung: in den Body geht die von der kanzleikonsole bestätigte ID.
        ['empfaengerId', KONTAKT.toUpperCase()],
        ['begruendung', BEGRUENDUNG],
        ['name', 'Gefälscht'],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    const parsed = s.parse!();
    const vorbereitet = await s.vorbereiten!(TX, K, parsed.data);
    expect(h.kontakte).toHaveBeenCalledWith(
      TX,
      { tenantId: TENANT, mandantId: MANDANT },
      [KONTAKT.toUpperCase()],
      { feld: 'empfaengerId' },
    );
    const d = dienst({ id: 'ak_1' });
    const ergebnis = await s.aufruf(d, parsed.data, vorbereitet);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.risikoakzeptanzAnfordern, {
      params: { risikoId: 'EC-UST-01' },
      body: { empfaengerId: KONTAKT, begruendung: BEGRUENDUNG },
    });
    expect((ergebnis as { meldung: string }).meldung).toContain('Jana Weller');
    expect((ergebnis as { meldung: string }).meldung).not.toContain('Gefälscht');
  });

  it('ein unzulässiger Kontakt beendet die Aktion vor dem Dienstaufruf', async () => {
    const fehler = new Error('unzulässig');
    h.kontakte.mockRejectedValue(fehler);
    await risikoakzeptanzAnfordernAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        ['empfaengerId', KONTAKT],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    const s = spec();
    await expect(s.vorbereiten!(TX, K, s.parse!().data)).rejects.toBe(fehler);
  });

  it('weist eine Empfänger-ID ohne UUID-Form als Feldfehler ab', async () => {
    await risikoakzeptanzAnfordernAction(
      MANDANT,
      null,
      formular([
        ['risikoId', 'EC-UST-01'],
        ['empfaengerId', 'jana'],
        ['begruendung', BEGRUENDUNG],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['empfaengerId']);
  });
});
