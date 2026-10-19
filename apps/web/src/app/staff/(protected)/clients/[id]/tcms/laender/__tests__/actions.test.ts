// TCMS Stufe 3, Bereich B: Verdrahtung der Aktionen des Länder-Monitors
// (Länderstände erfassen, Land aufnehmen). Das Lesen der Formulare testet
// server/tcms/bereich-b/__tests__/laender-formular.test.ts.
// Fachkatalog: TCMS-DIENST-001
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spec: null as null | Record<string, unknown> }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));

import { landHinzufuegenAction, landStaendeSpeichernAction } from '../actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const FREMD = 'a1000000-0000-4000-8000-000000004720';

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: Record<string, unknown> };
  vorbereiten?: unknown;
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

const FR = {
  land: 'FR',
  fernverkaeufeLfdEur: 12345.67,
  fernverkaeufeVorjahrEur: 0,
  lagerSeit: null,
  oss: true,
  lokaleUstNr: false,
  zmRelevant: false,
  steuersaetzeGeprueftAm: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
});

describe('landStaendeSpeichernAction', () => {
  it('Einzelerfassung: Felder ohne Präfix, Mandant aus dem gebundenen Argument', async () => {
    await landStaendeSpeichernAction(
      MANDANT,
      null,
      formular([
        ['datenstand', '2026-09-30'],
        ['land', 'FR'],
        ['fernverkaeufeLfdEur', '12.345,67 €'],
        ['fernverkaeufeVorjahrEur', ''],
        ['oss', 'on'],
        ['mandantId', FREMD],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.felder).toEqual({ datenstand: 'datenstand', land: 'land' });
    const parsed = s.parse!();
    expect(parsed.ok).toBe(true);
    const rufe = vi.fn(async () => ({
      daten: { staende: [{ land: 'FR' }], ereignisse: ['E-2026-014'] },
      requestId: 'r',
    }));
    const ergebnis = (await s.aufruf({ rufe }, parsed.data, undefined)) as { meldung: string };
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.landStaendeSpeichern, {
      body: { datenstand: '2026-09-30', laender: [FR] },
    });
    expect(ergebnis.meldung).toBe(
      'Neuer Stand für FR gespeichert; der bisherige Stand bleibt in der Historie. Ereignis E-2026-014 im Ereigniseingang angelegt.',
    );
  });

  it('Sammelerfassung (`sammel=1`): Felder je Land mit Präfix', async () => {
    await landStaendeSpeichernAction(
      MANDANT,
      null,
      formular([
        ['sammel', '1'],
        ['datenstand', '2026-09-30'],
        ['land', 'FR'],
        ['land', 'IT'],
        ['FR.fernverkaeufeLfdEur', '12345,67'],
        ['FR.oss', 'on'],
        ['IT.fernverkaeufeLfdEur', '800'],
        ['IT.lagerSeit', '2026-03'],
        // Felder ohne Präfix zählen in der Sammelerfassung nicht.
        ['fernverkaeufeLfdEur', '999999'],
      ]),
    );
    const s = spec();
    const parsed = s.parse!();
    expect(parsed.ok).toBe(true);
    const rufe = vi.fn(async () => ({
      daten: { staende: [{ land: 'FR' }, { land: 'IT' }], ereignisse: [] },
      requestId: 'r',
    }));
    const ergebnis = (await s.aufruf({ rufe }, parsed.data, undefined)) as { meldung: string };
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.landStaendeSpeichern, {
      body: {
        datenstand: '2026-09-30',
        laender: [
          FR,
          {
            ...FR,
            land: 'IT',
            fernverkaeufeLfdEur: 800,
            oss: false,
            lagerSeit: '2026-03',
          },
        ],
      },
    });
    expect(ergebnis.meldung).toBe(
      '2 Länderstände gespeichert; frühere Stände bleiben in der Historie.',
    );
  });

  it('Feldfehler der Sammelerfassung stehen am Feld des Landes', async () => {
    await landStaendeSpeichernAction(
      MANDANT,
      null,
      formular([
        ['sammel', '1'],
        ['datenstand', '2026-09-30'],
        ['land', 'FR'],
        ['FR.fernverkaeufeLfdEur', '-5'],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['FR.fernverkaeufeLfdEur']);
  });
});

describe('landHinzufuegenAction', () => {
  it('nimmt genau ein Land auf und meldet es mit Namen', async () => {
    await landHinzufuegenAction(
      MANDANT,
      null,
      formular([
        ['datenstand', '2026-09-30'],
        ['land', 'AT'],
        ['fernverkaeufeLfdEur', '1.000'],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    const parsed = s.parse!();
    const rufe = vi.fn(async () => ({ daten: { ereignisse: [] }, requestId: 'r' }));
    const ergebnis = (await s.aufruf({ rufe }, parsed.data, undefined)) as {
      meldung: string;
      land: string;
    };
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.landHinzufuegen, {
      body: {
        datenstand: '2026-09-30',
        land: { ...FR, land: 'AT', fernverkaeufeLfdEur: 1000, oss: false },
      },
    });
    expect(ergebnis.land).toBe('AT');
    expect(ergebnis.meldung).toBe('Österreich (AT) in den Monitor aufgenommen.');
  });

  it('mehrere Länder oder `sammel` gelten beim Aufnehmen nicht', async () => {
    await landHinzufuegenAction(
      MANDANT,
      null,
      formular([
        ['sammel', '1'],
        ['datenstand', '2026-09-30'],
        ['land', 'AT'],
        ['land', 'BE'],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors ?? {})).toEqual(['land']);
  });
});
