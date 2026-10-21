// TCMS Stufe 3, Bereich A: Verdrahtung von „Neu adressieren“
// (`freigabeNeuadressieren`, TS-06). Ablauf, Gate und Fehlerabbildung testet
// server/tcms/__tests__/aktion.test.ts; hier: Mandant aus dem gebundenen
// Argument, Empfänger nur als aktiver Kontakt genau dieses Mandanten (Name aus
// der Datenbank), Anforderung als Pfadparameter.
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
// kk-tcms-s11: neu adressiert wird nur an Kontakte mit aktivem Portalzugang.
vi.mock('@/server/tcms/personen', () => ({ freigabeEmpfaengerTx: h.kontakte }));

import { DEMO } from '@/__tests__/tcms-fixtures';
import { freigabeNeuadressierenAction } from '../actions';

const TX = { tx: true };
const K = { g: { tenantId: DEMO.tenant }, akteur: {}, mandantId: DEMO.talwind };

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse: () => { ok: boolean; data?: unknown };
  vorbereiten: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function formular(felder: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.kontakte.mockResolvedValue({ id: DEMO.murat, name: 'Murat Yilmaz' });
});

describe('freigabeNeuadressierenAction', () => {
  it('prüft den Empfänger beim Mandanten der Aktion (mit Portalzugang) und adressiert die Anforderung neu', async () => {
    await freigabeNeuadressierenAction(
      DEMO.talwind,
      null,
      formular({
        freigabeId: 'cmvf9k8nd0095g87dk8fp5l35',
        empfaengerId: DEMO.murat,
        mandantId: DEMO.seestern,
      }),
    );
    const s = h.spec as unknown as Spec;
    expect(s.mandantId).toBe(DEMO.talwind);
    expect(s.keinRecht).toBe('BEARBEITEN');
    expect(s.felder).toEqual({ empfaengerId: 'empfaengerId' });
    const parsed = s.parse();
    expect(parsed).toEqual({
      ok: true,
      data: { freigabeId: 'cmvf9k8nd0095g87dk8fp5l35', empfaengerId: DEMO.murat },
    });
    const kontakt = await s.vorbereiten(TX, K, parsed.data);
    expect(h.kontakte).toHaveBeenCalledWith(
      TX,
      { tenantId: DEMO.tenant, mandantId: DEMO.talwind },
      DEMO.murat,
      { feld: 'empfaengerId' },
    );
    const rufe = vi.fn(async () => ({
      daten: { freigabeId: 'f', codeVerfallen: true },
      requestId: 'r',
    }));
    await expect(s.aufruf({ rufe }, parsed.data, kontakt)).resolves.toEqual({
      meldung:
        'Die Anforderung ist jetzt an Murat Yilmaz adressiert; ein ausgestellter Code ist verfallen.',
    });
    expect(rufe).toHaveBeenCalledWith(ENDPUNKTE.freigabeNeuadressieren, {
      params: { freigabeId: 'cmvf9k8nd0095g87dk8fp5l35' },
      body: { empfaengerId: DEMO.murat },
    });
  });

  it.each([
    [{ freigabeId: '../f', empfaengerId: DEMO.murat }],
    [{ freigabeId: 'f', empfaengerId: 'murat' }],
    [{ freigabeId: 'f' }],
  ])('ungültige Eingabe %o: abgewiesen', async (felder) => {
    await freigabeNeuadressierenAction(DEMO.talwind, null, formular(felder));
    expect((h.spec as unknown as Spec).parse().ok).toBe(false);
  });
});
