// TCMS Stufe 3, Bereich A: Verdrahtung von „Profil ändern“ (`profilAendern`)
// und „Risiko aufnehmen“ (`profilRisikoAufnehmen`). Ablauf, Gate und
// Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts; hier: Mandant
// aus dem gebundenen Argument, Profil streng aus JSON, Verantwortliche aus der
// Zuständigkeit der kanzleikonsole (nie aus dem Formular), Weiterleitung nur
// nach Erfolg und nur mit Zahlen/Codes aus der Antwort des Dienstes.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import { ENDPUNKTE, ProfilAntwortenSchema } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  ergebnis: {} as Record<string, unknown>,
  zust: vi.fn(),
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
vi.mock('@/server/tcms/programm/zustaendigkeit', async (orig) => ({
  ...(await orig<typeof import('@/server/tcms/programm/zustaendigkeit')>()),
  tcmsZustaendigkeitTx: h.zust,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { ActionError } from '@/server/actions/action-error';
import { AUFNAHME_TEXTE } from '@/server/tcms/programm/zustaendigkeit';
import { PROFIL_ALTBESTAND_HINWEIS } from '@/components/tcms/programm/profil-fehler';
import { profilAendernAction, risikoAufnehmenAction } from '../actions';

const MANDANT = DEMO.talwind;
const TX = { tx: true };
const K = { g: { tenantId: DEMO.tenant }, akteur: {}, mandantId: MANDANT };
const ANNA = { id: DEMO.anna, name: 'StB Dr. Anna Roth' };
const LEON = { id: DEMO.leon, name: 'Leon Brandt' };
const THOMAS = { id: DEMO.thomas, name: 'Thomas Kühn' };

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse: () => { ok: boolean; data?: unknown; error?: string; fieldErrors?: unknown };
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

function profil() {
  return tcmsFixtures.profilTalwind().staende.at(-1)!.antworten;
}

function aendernFormular(werte: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(werte)) fd.set(k, v);
  fd.set('mandantId', DEMO.seestern);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  // Neutral: der gemockte Helfer meldet Misserfolg (keine Weiterleitung), außer der Test setzt Erfolg.
  h.ergebnis = { ok: false, error: 'gemockt', errorCode: 'VALIDATION_ERROR' };
  h.zust.mockResolvedValue({
    berufstraeger: ANNA,
    bearbeitung: LEON,
    kanzlei: [ANNA, LEON, THOMAS],
    vertretung: THOMAS,
  });
});

describe('profilAendernAction', () => {
  it('sendet Profil, Basisstand und Gültigkeit; Ereignisse nur mit Haken', async () => {
    const p = profil();
    await profilAendernAction(
      MANDANT,
      null,
      aendernFormular({
        profilStandId: 'cmv-stand_1',
        profil: JSON.stringify(p),
        gueltigAb: '2026-11-01',
      }),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.felder).toEqual({ gueltigAb: 'gueltigAb', profil: 'profil', profilStandId: 'profil' });
    const parsed = s.parse();
    expect(parsed).toMatchObject({
      ok: true,
      data: { profilStandId: 'cmv-stand_1', gueltigAb: '2026-11-01', ereignisseAnlegen: false },
    });
    const d = dienst({
      profilStandId: 'neu',
      neuBewerten: ['EC-UST-01', 'EC-UST-02'],
      ereignisse: ['e1'],
      neuVorgeschlagen: [],
    });
    await expect(s.aufruf(d, parsed.data, undefined)).resolves.toEqual({ nb: 2, ev: 1, nv: 0 });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.profilAendern, { body: parsed.data });
  });

  it('nach Erfolg zur Historie mit den Zahlen der Antwort', async () => {
    h.ergebnis = { ok: true, nb: 2, ev: 1, nv: 0 };
    await expect(
      profilAendernAction(
        MANDANT,
        null,
        aendernFormular({
          profilStandId: 'x',
          profil: JSON.stringify(profil()),
          gueltigAb: '2026-11-01',
          ereignisse: 'on',
        }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(h.redirect).toHaveBeenCalledWith(
      `/staff/clients/${MANDANT}/tcms/profil?geaendert=1&nb=2&ev=1&nv=0#historie`,
    );
    expect(spec().parse()).toMatchObject({ ok: true, data: { ereignisseAnlegen: true } });
  });

  it('ohne Erfolg keine Weiterleitung', async () => {
    h.ergebnis = { ok: false, error: 'x', errorCode: 'CONFLICT' };
    await expect(
      profilAendernAction(MANDANT, null, aendernFormular({ profilStandId: 'x' })),
    ).resolves.toEqual(h.ergebnis);
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it.each([
    ['Basisstand mit Sonderzeichen', { profilStandId: '../x', gueltigAb: '2026-11-01' }],
    ['Datum ungültig', { profilStandId: 'x', gueltigAb: '01.11.2026' }],
    ['Datum fehlt', { profilStandId: 'x' }],
  ])('%s: abgewiesen', async (_name, felder) => {
    await profilAendernAction(
      MANDANT,
      null,
      aendernFormular({ ...felder, profil: JSON.stringify(profil()) }),
    );
    expect(spec().parse().ok).toBe(false);
  });

  it('doppelte Schlüssel und Fremdfelder im Profil werden abgewiesen', async () => {
    const roh = JSON.stringify(profil());
    await profilAendernAction(
      MANDANT,
      null,
      aendernFormular({
        profilStandId: 'x',
        gueltigAb: '2026-11-01',
        profil: `{"p1":null,${roh.slice(1)}`,
      }),
    );
    expect(spec().parse()).toMatchObject({ ok: false });
    await profilAendernAction(
      MANDANT,
      null,
      aendernFormular({
        profilStandId: 'x',
        gueltigAb: '2026-11-01',
        profil: JSON.stringify({ ...profil(), mandantId: DEMO.seestern }),
      }),
    );
    expect(spec().parse()).toMatchObject({
      ok: false,
      fieldErrors: { profil: ['Bitte prüfen Sie die Angaben des Profils.'] },
    });
  });
});

describe('Altbestand des Profils (TCMS s8)', () => {
  /** Stand vor der Zeichenregel: Zeilenumbruch im Shopsystem, Nullbreite in einer Warengruppe. */
  function altbestand() {
    const p = structuredClone(profil());
    p.p1.shopSystem = 'Shopware\n6';
    p.p4.warengruppen = [
      { name: 'Textil', abweichenderSatz: false },
      { name: `Bücher${String.fromCodePoint(0x200b)}`, abweichenderSatz: true },
    ];
    return p;
  }

  it('wird tolerant gelesen (Antwort des Dienstes), aber nur nach der Eingaberegel gespeichert', () => {
    const daten = tcmsFixtures.profilTalwind();
    daten.staende.at(-1)!.antworten = altbestand();
    expect(ENDPUNKTE.profilLesen.antwortSchema.safeParse(daten).success).toBe(true);
    expect(ProfilAntwortenSchema.safeParse(altbestand()).success).toBe(false);
  });

  it('erneutes Speichern: Feldfehler mit Frage und Feld, Hinweis auf den Altbestand, kein Dienstaufruf', async () => {
    await profilAendernAction(
      MANDANT,
      null,
      aendernFormular({
        profilStandId: 'cmv-stand_1',
        profil: JSON.stringify(altbestand()),
        gueltigAb: '2026-11-01',
      }),
    );
    const p = spec().parse();
    expect(p.ok).toBe(false);
    expect(p.error).toBe(PROFIL_ALTBESTAND_HINWEIS);
    const zeilen = (p.fieldErrors as Record<string, string[]>)['profil'];
    expect(zeilen).toEqual(
      expect.arrayContaining([
        'P1 Verkaufskanäle · Shopsystem: Unzulässige Zeichen',
        'P4 Sortiment und Steuersätze · Warengruppe 2: Unzulässige Zeichen',
      ]),
    );
    expect(zeilen).toHaveLength(2);
  });
});

describe('risikoAufnehmenAction', () => {
  function aufnehmen(code: string, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set('code', code);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return risikoAufnehmenAction(MANDANT, null, fd);
  }

  it('Verantwortliche aus der Zuständigkeit der kanzleikonsole, nicht aus dem Formular', async () => {
    await aufnehmen('EC-UST-05', { verantwortliche: JSON.stringify({ berufstraeger: THOMAS }) });
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    const parsed = s.parse();
    expect(parsed).toEqual({ ok: true, data: { code: 'EC-UST-05' } });
    const v = await s.vorbereiten!(TX, K, parsed.data);
    expect(h.zust).toHaveBeenCalledWith(TX, { tenantId: DEMO.tenant, mandantId: MANDANT });
    expect(v).toEqual({ berufstraeger: ANNA, hauptbearbeitung: LEON, vertretung: THOMAS });
    const d = dienst({
      code: 'EC-UST-05',
      risikoId: 'r',
      neueKontrollen: ['K-EC-03', 'K-EC-04'],
      verknuepft: ['K-EC-01'],
      neuGeplant: [{ code: 'K-EC-01', anzahl: 2 }],
      durchfuehrungen: 7,
    });
    await expect(s.aufruf(d, parsed.data, v)).resolves.toEqual({
      code: 'EC-UST-05',
      kn: 'K-EC-03,K-EC-04',
      vk: 'K-EC-01',
      ng: 'K-EC-01',
      d: 7,
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.profilRisikoAufnehmen, {
      body: { code: 'EC-UST-05', verantwortliche: v },
    });
  });

  it.each([
    [
      'ohne Berufsträger:in',
      { berufstraeger: null, bearbeitung: LEON },
      AUFNAHME_TEXTE.keineZustaendigkeit,
    ],
    [
      'ohne Hauptbearbeitung',
      { berufstraeger: ANNA, bearbeitung: null },
      AUFNAHME_TEXTE.keineZustaendigkeit,
    ],
    ['dieselbe Person', { berufstraeger: ANNA, bearbeitung: ANNA }, AUFNAHME_TEXTE.gleichePerson],
  ])('%s: feste Meldung statt Dienstaufruf', async (_n, z, text) => {
    h.zust.mockResolvedValue({ kanzlei: [], vertretung: null, ...z });
    await aufnehmen('EC-UST-05');
    const s = spec();
    const fehler = await s.vorbereiten!(TX, K, { code: 'EC-UST-05' }).catch((e: unknown) => e);
    expect(fehler).toBeInstanceOf(ActionError);
    expect((fehler as Error).message).toBe(text);
  });

  it.each(['ec-ust-05', 'EC-UST-5', 'K-EC-01', 'EC-UST-05,EC-UST-06', ''])(
    'Code „%s“: abgewiesen',
    async (code) => {
      await aufnehmen(code);
      expect(spec().parse().ok).toBe(false);
    },
  );

  it('nach Erfolg zum Vorschlag mit Codes der Antwort; leere Listen entfallen', async () => {
    h.ergebnis = { ok: true, code: 'EC-UST-05', kn: 'K-EC-03', vk: '', ng: '', d: 0 };
    await expect(aufnehmen('EC-UST-05')).rejects.toThrow('NEXT_REDIRECT');
    expect(h.redirect).toHaveBeenCalledWith(
      `/staff/clients/${MANDANT}/tcms/profil?aufgenommen=EC-UST-05&kn=K-EC-03&d=0#vorschlaege`,
    );
  });
});
