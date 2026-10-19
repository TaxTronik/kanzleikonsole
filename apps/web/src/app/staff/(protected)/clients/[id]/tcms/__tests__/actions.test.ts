// TCMS Stufe 3: Verdrahtung der Aktionen „Mandant im Tax-CMS anlegen“ und
// „Kontaktrollen setzen“. Ablauf, Gate und Fehlerabbildung testet
// server/tcms/__tests__/aktion.test.ts; hier geht es darum, was die Aktion dem
// Helfer übergibt: Mandant aus dem gebundenen Argument, Personen und
// Stammdaten aus der kanzleikonsole, Body des Dienstaufrufs.
// Fachkatalog: TCMS-AKTEUR-001
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  kontakte: vi.fn(),
  anker: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));
vi.mock('@/server/tcms/personen', () => ({ mandantKontakteTx: h.kontakte }));
vi.mock('@/server/tcms/mandant', () => ({ mandantAnkerTx: h.anker }));

import { mandantImTcmsAnlegenAction } from '../actions';
import { kontaktRollenSetzenAction } from '../kontakte/actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const FREMD = 'a1000000-0000-4000-8000-000000004720';
const KONTAKT = 'b1000000-0000-4000-8000-000000000011';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const TX = { tx: true };
const K = { g: { tenantId: TENANT }, akteur: {}, mandantId: MANDANT };

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: unknown };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function dienst(antwort: unknown = {}) {
  const rufe = vi.fn(async () => ({ daten: antwort, requestId: 'r' }));
  return { rufe };
}

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.kontakte.mockImplementation(async (_tx, _bezug, ids: string[]) =>
    ids.map((id) => ({ id, name: 'Jana', aktiv: true })),
  );
});

describe('mandantImTcmsAnlegenAction', () => {
  it('Mandant aus dem gebundenen Argument, Anker aus der kanzleikonsole, nicht aus dem Formular', async () => {
    const anker = { name: 'Talwind Outdoor GmbH', rechtsform: 'GmbH', datevNr: '4711' };
    h.anker.mockResolvedValue(anker);
    const fd = formular([
      ['name', 'Gefälscht AG'],
      ['mandantId', FREMD],
    ]);
    await mandantImTcmsAnlegenAction(MANDANT, null, fd);
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.parse).toBeUndefined();

    const vorbereitet = await s.vorbereiten!(TX, K, undefined);
    expect(h.anker).toHaveBeenCalledWith(TX, TENANT, MANDANT);
    const d = dienst({ angelegt: true, geaendert: true });
    await expect(s.aufruf(d, undefined, vorbereitet)).resolves.toEqual({
      angelegt: true,
      geaendert: true,
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.mandantAnkerSetzen, { body: anker });
  });
});

describe('kontaktRollenSetzenAction', () => {
  it('prüft den Kontakt beim Mandanten der Aktion und sendet Rollen ohne Dubletten', async () => {
    await kontaktRollenSetzenAction(
      MANDANT,
      null,
      formular([
        ['kontaktId', KONTAKT],
        ['rollen', 'GESETZLICHER_VERTRETER'],
        ['rollen', 'GESETZLICHER_VERTRETER'],
        ['rollen', 'MITARBEITER'],
        ['funktion', ' Geschäftsführerin '],
        ['mandantId', FREMD],
      ]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    const parsed = s.parse!();
    expect(parsed.ok).toBe(true);

    const vorbereitet = await s.vorbereiten!(TX, K, parsed.data);
    // Rollen zuweisen: nur aktive Kontakte genau dieses Mandanten.
    expect(h.kontakte).toHaveBeenCalledWith(
      TX,
      { tenantId: TENANT, mandantId: MANDANT },
      [KONTAKT],
      {
        feld: 'kontaktId',
        auchInaktive: false,
      },
    );
    const d = dienst({});
    await s.aufruf(d, parsed.data, vorbereitet);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.kontaktRollenSetzen, {
      body: {
        kontaktId: KONTAKT,
        rollen: ['GESETZLICHER_VERTRETER', 'MITARBEITER'],
        funktion: 'Geschäftsführerin',
      },
    });
  });

  it('Rollen entfernen geht auch bei inaktiven Kontakten; Funktion entfällt dann', async () => {
    await kontaktRollenSetzenAction(
      MANDANT,
      null,
      formular([
        ['kontaktId', KONTAKT],
        ['funktion', 'Prokurist'],
      ]),
    );
    const s = spec();
    const parsed = s.parse!();
    expect(parsed.ok).toBe(true);
    const vorbereitet = await s.vorbereiten!(TX, K, parsed.data);
    expect(h.kontakte.mock.calls[0]![3]).toEqual({ feld: 'kontaktId', auchInaktive: true });
    const d = dienst({});
    await s.aufruf(d, parsed.data, vorbereitet);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.kontaktRollenSetzen, {
      body: { kontaktId: KONTAKT, rollen: [], funktion: null },
    });
  });

  it('weist unbekannte Rollen und ungültige Kontakt-IDs als Feldfehler ab', async () => {
    await kontaktRollenSetzenAction(
      MANDANT,
      null,
      formular([
        ['kontaktId', 'kein-uuid'],
        ['rollen', 'ADMIN'],
      ]),
    );
    const parsed = spec().parse!();
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed.fieldErrors as object).sort()).toEqual(['kontaktId', 'rollen']);
  });

  it('ein unzulässiger Kontakt beendet die Aktion vor dem Dienstaufruf', async () => {
    const fehler = new Error('unzulässig');
    h.kontakte.mockRejectedValue(fehler);
    await kontaktRollenSetzenAction(MANDANT, null, formular([['kontaktId', KONTAKT]]));
    const s = spec();
    await expect(s.vorbereiten!(TX, K, s.parse!().data)).rejects.toBe(fehler);
  });
});
