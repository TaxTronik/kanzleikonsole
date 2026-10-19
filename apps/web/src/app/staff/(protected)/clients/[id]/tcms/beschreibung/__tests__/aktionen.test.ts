// TCMS Stufe 3, Bereich A: Verdrahtung der Aktionen der CMS-Beschreibung
// (Version anlegen, Abschnitt speichern, Review, Zurückweisen, Freigabe
// anfordern). Ablauf, Gate und Fehlerabbildung testet
// server/tcms/__tests__/aktion.test.ts; hier: Mandant aus dem gebundenen
// Argument, Blöcke aus dem Formular nach der Struktur des Editors, Empfänger
// nur als Kontakt dieses Mandanten, Zuständigkeit und Namen für den
// eingefrorenen Inhalt aus der kanzleikonsole.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import { ENDPUNKTE, REVIEW_MIN_BEGRUENDUNG } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  ergebnis: {} as Record<string, unknown>,
  kontakte: vi.fn(),
  zust: vi.fn(),
  namen: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return h.ergebnis;
  }),
}));
vi.mock('@/server/tcms/personen', () => ({ mandantKontakteTx: h.kontakte }));
vi.mock('@/server/tcms/programm/zustaendigkeit', () => ({
  tcmsZustaendigkeitTx: h.zust,
  freigabeNamenTx: h.namen,
}));

import { DEMO } from '@/__tests__/tcms-fixtures';
import {
  abschnittSpeichernAction,
  freigabeAnfordernAction,
  reviewAbschliessenAction,
  reviewZurueckweisenAction,
  versionAnlegenAction,
  zurReviewAction,
} from '../actions';

const MANDANT = DEMO.talwind;
const TX = { tx: true };
const K = { g: { tenantId: DEMO.tenant }, akteur: {}, mandantId: MANDANT };
const BEZUG = { tenantId: DEMO.tenant, mandantId: MANDANT };
const VERSION = 'cmvf9k8n20093g87donaw4i34';

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse?: () => { ok: boolean; data?: unknown; error?: string; fieldErrors?: unknown };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function dienst(antwort: unknown) {
  return { rufe: vi.fn(async () => ({ daten: antwort, requestId: 'r' })) };
}

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  fd.append('mandantId', DEMO.seestern);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.ergebnis = { ok: false, error: 'gemockt', errorCode: 'VALIDATION_ERROR' };
});

describe('versionAnlegenAction', () => {
  it('legt die Version ohne Formulardaten an und öffnet sie nach Erfolg', async () => {
    await versionAnlegenAction(MANDANT, null, formular([['versionId', 'x']]));
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.parse).toBeUndefined();
    const d = dienst({ versionId: 'v14', nummer: '1.4' });
    await expect(s.aufruf(d, undefined, undefined)).resolves.toEqual({
      versionId: 'v14',
      meldung: 'Version 1.4 angelegt.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.beschreibungsversionAnlegen);

    h.ergebnis = { ok: true, versionId: 'v14' };
    await expect(versionAnlegenAction(MANDANT, null, formular([]))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(h.redirect).toHaveBeenCalledWith(
      `/staff/clients/${MANDANT}/tcms/beschreibung?version=v14`,
    );
  });
});

describe('abschnittSpeichernAction', () => {
  const struktur = JSON.stringify([
    { typ: 'text' },
    { typ: 'baustein', art: 'TEILBEREICH' },
    { typ: 'text' },
    { typ: 'baustein', art: 'ZIELE' },
  ]);

  async function parse(felder: Array<[string, string]>) {
    await abschnittSpeichernAction(MANDANT, null, formular(felder));
    return spec().parse!();
  }

  it('baut die Blöcke in der Reihenfolge des Editors; entfernte Bausteine entfallen', async () => {
    const r = await parse([
      ['versionId', VERSION],
      ['key', 'teilbereich'],
      ['struktur', struktur],
      ['text', 'Erster Absatz'],
      ['text', 'Zweiter Absatz'],
      ['entfernen', '3'],
      ['neuerBaustein', 'LAENDER'],
    ]);
    expect(r).toEqual({
      ok: true,
      data: {
        versionId: VERSION,
        key: 'teilbereich',
        bloecke: [
          { typ: 'text', text: 'Erster Absatz' },
          { typ: 'baustein', art: 'TEILBEREICH' },
          { typ: 'text', text: 'Zweiter Absatz' },
          { typ: 'baustein', art: 'LAENDER' },
        ],
      },
    });
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.felder).toEqual({ bloecke: 'text', key: 'text' });
    const d = dienst({ nummer: '1.3', geaendert: true });
    await expect(s.aufruf(d, r.data, undefined)).resolves.toEqual({
      meldung: 'Abschnitt in Version 1.3 gespeichert.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.beschreibungsabschnittSpeichern, {
      params: { versionId: VERSION },
      body: {
        key: 'teilbereich',
        bloecke: (r.data as { bloecke: unknown }).bloecke,
      },
    });
  });

  it('ein Baustein darf im Abschnitt nur einmal vorkommen', async () => {
    const r = await parse([
      ['versionId', VERSION],
      ['key', 'teilbereich'],
      ['struktur', struktur],
      ['text', 'a'],
      ['text', 'b'],
      ['neuerBaustein', 'ZIELE'],
    ]);
    expect(r).toMatchObject({
      ok: false,
      fieldErrors: { neuerBaustein: ['Dieser Baustein ist bereits enthalten.'] },
    });
  });

  it('leerer Abschnitt mit neuem Text: Text wird erster Block', async () => {
    const r = await parse([
      ['versionId', VERSION],
      ['key', 'ziele'],
      ['struktur', '[]'],
      ['textNeu', 'Neuer Text'],
    ]);
    expect(r).toMatchObject({
      ok: true,
      data: { bloecke: [{ typ: 'text', text: 'Neuer Text' }] },
    });
  });

  it.each([
    ['unbekannter Abschnitt', [['key', 'geheim']]],
    ['unbekannte Bausteinart in der Struktur', [['struktur', '[{"typ":"baustein","art":"X"}]']]],
    ['doppelte Schlüssel in der Struktur', [['struktur', '[{"typ":"text","typ":"text"}]']]],
    ['Version mit Pfadzeichen', [['versionId', '../x']]],
  ] as Array<[string, Array<[string, string]>]>)('%s: abgewiesen', async (_n, felder) => {
    const basis = new Map<string, string>([
      ['versionId', VERSION],
      ['key', 'teilbereich'],
      ['struktur', '[{"typ":"text"}]'],
    ]);
    for (const [k, v] of felder) basis.set(k, v);
    const r = await parse([...basis, ['text', 'a']]);
    expect(r.ok).toBe(false);
  });

  it('zu langer Text: Sammelmeldung mit Feld „text“', async () => {
    const r = await parse([
      ['versionId', VERSION],
      ['key', 'teilbereich'],
      ['struktur', '[{"typ":"text"}]'],
      ['text', 'x'.repeat(20_001)],
    ]);
    expect(r).toMatchObject({ ok: false, fieldErrors: { text: ['Bitte kürzen Sie den Text.'] } });
  });
});

describe('Review', () => {
  it('zur Review geben und Review abschließen senden nur die Version', async () => {
    await zurReviewAction(MANDANT, null, formular([['versionId', VERSION]]));
    let s = spec();
    expect(s.keinRecht).toBe('BEARBEITEN');
    let d = dienst({ nummer: '1.3' });
    await s.aufruf(d, s.parse!().data, undefined);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.beschreibungZurReviewGeben, {
      params: { versionId: VERSION },
    });

    await reviewAbschliessenAction(MANDANT, null, formular([['versionId', VERSION]]));
    s = spec();
    // 403 heißt hier Vier-Augen-Prinzip: eigene Meldung statt „kein Recht“.
    expect(s.keinRecht).toBe('VIER_AUGEN');
    d = dienst({ nummer: '1.3' });
    await expect(s.aufruf(d, s.parse!().data, undefined)).resolves.toEqual({
      meldung: 'Kanzlei-Review für Version 1.3 abgeschlossen.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.beschreibungsreviewAbschliessen, {
      params: { versionId: VERSION },
    });
  });

  it('Zurückweisen verlangt eine Begründung mit Mindestlänge (getrimmt)', async () => {
    const kurz = `  ${'x'.repeat(REVIEW_MIN_BEGRUENDUNG - 1)}  `;
    await reviewZurueckweisenAction(
      MANDANT,
      null,
      formular([
        ['versionId', VERSION],
        ['begruendung', kurz],
      ]),
    );
    expect(spec().parse!()).toMatchObject({
      ok: false,
      fieldErrors: { begruendung: [expect.any(String)] },
    });
    expect(spec().felder).toEqual({ begruendung: 'begruendung' });

    const text = 'Abschnitt 3 nennt die Kontrollen K-EC-05 und K-EC-06 nicht.';
    await reviewZurueckweisenAction(
      MANDANT,
      null,
      formular([
        ['versionId', VERSION],
        ['begruendung', ` ${text} `],
      ]),
    );
    const s = spec();
    const parsed = s.parse!();
    expect(parsed).toEqual({ ok: true, data: { versionId: VERSION, begruendung: text } });
    const d = dienst({ nummer: '1.3' });
    await s.aufruf(d, parsed.data, undefined);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.beschreibungsreviewZurueckweisen, {
      params: { versionId: VERSION },
      body: { begruendung: text },
    });
  });
});

describe('freigabeAnfordernAction', () => {
  const JANA = { id: DEMO.jana, name: 'Jana Weller', aktiv: true };
  const ZUST = {
    berufstraeger: { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
    bearbeitung: { id: DEMO.leon, name: 'Leon Brandt' },
    kanzlei: [],
    vertretung: null,
  };
  const NAMEN = [
    { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
    { id: DEMO.jana, name: 'Jana Weller' },
  ];

  beforeEach(() => {
    h.kontakte.mockResolvedValue([JANA]);
    h.zust.mockResolvedValue(ZUST);
    h.namen.mockResolvedValue(NAMEN);
  });

  it('Empfänger nur als aktiver Kontakt dieses Mandanten; Zuständigkeit und Namen aus der kanzleikonsole', async () => {
    await freigabeAnfordernAction(
      MANDANT,
      null,
      formular([
        ['versionId', VERSION],
        ['empfaengerId', DEMO.jana],
        ['namen', JSON.stringify([{ id: DEMO.anna, name: 'Gefälscht' }])],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.felder).toEqual({ empfaengerId: 'empfaengerId' });
    const parsed = s.parse!();
    expect(parsed).toEqual({ ok: true, data: { versionId: VERSION, empfaengerId: DEMO.jana } });
    const v = await s.vorbereiten!(TX, K, parsed.data);
    expect(h.kontakte).toHaveBeenCalledWith(TX, BEZUG, [DEMO.jana], { feld: 'empfaengerId' });
    expect(h.zust).toHaveBeenCalledWith(TX, BEZUG);
    expect(h.namen).toHaveBeenCalledWith(TX, BEZUG);
    const d = dienst({ freigabeId: 'f', nummer: '1.3', zurueckgezogen: ['1.2'] });
    await expect(s.aufruf(d, parsed.data, v)).resolves.toEqual({
      meldung:
        'Freigabe von Version 1.3 bei Jana Weller angefordert; der Inhalt ist eingefroren, der Bestätigungscode geht über den Postausgang. Die offene Anforderung für Version 1.2 wurde zurückgezogen.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.beschreibungsfreigabeAnfordern, {
      params: { versionId: VERSION },
      body: {
        empfaengerId: DEMO.jana,
        verantwortung: { berufstraeger: ZUST.berufstraeger, bearbeitung: ZUST.bearbeitung },
        namen: NAMEN,
      },
    });
  });

  it('abgelehnter Kontakt: kein Laden weiterer Daten, kein Dienstaufruf', async () => {
    const fehler = new Error('Kontakt unzulässig');
    h.kontakte.mockRejectedValueOnce(fehler);
    await freigabeAnfordernAction(
      MANDANT,
      null,
      formular([
        ['versionId', VERSION],
        ['empfaengerId', DEMO.murat],
      ]),
    );
    const s = spec();
    await expect(s.vorbereiten!(TX, K, s.parse!().data)).rejects.toBe(fehler);
    expect(h.namen).not.toHaveBeenCalled();
  });

  it.each(['', 'jana', `${DEMO.jana},${DEMO.murat}`])('Empfänger „%s“: abgewiesen', async (id) => {
    await freigabeAnfordernAction(
      MANDANT,
      null,
      formular([
        ['versionId', VERSION],
        ['empfaengerId', id],
      ]),
    );
    expect(spec().parse!()).toMatchObject({ ok: false });
  });
});
