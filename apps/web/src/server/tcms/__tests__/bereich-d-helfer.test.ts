// TCMS Stufe 3, Bereich D: kleine Helfer der Portal- und Triage-Oberflächen.
//   - Body der Kontrollaufgabe aus dem Formular nach dem Aufbau laut Dienst
//     (Differenzkennzahlen ohne Wert – die berechnet das Tax-CMS).
//   - Zuständigkeit nur als `K:<uuid>`/`M:<uuid>`; Auswahl und Vorbelegung aus
//     der kanzleikonsole, nur Personen mit Zugriff auf den Mandanten.
//   - Feste Texte zum Bestätigungscode, ohne den Code.
// Fachkatalog: TCMS-DIENST-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ filter: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/auth/rbac', () => ({ filterStaffAccessClientTx: h.filter }));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { auswahlProblem } from '@/components/tcms/portal/anlagen-upload';
import { codeFehlerText, portalAnlageHinweis } from '@/components/tcms/portal/texte';
import { parseDezimal } from '@/components/tcms/durchfuehrung/werte';
import {
  kanzleiPersonenAuswahlTx,
  zustaendigkeitTx,
  zuweisungAusFormular,
} from '../ereignisse/personen';
import { TcmsPersonUnzulaessig } from '../personen';
import { BETRAG_FORMAT, koerperAusFormular } from '../portal/aufgabe';
import { TEXT_UNZULAESSIG_MELDUNG } from '@taxtronik/tcms-contract';

const BEZUG = { tenantId: DEMO.tenant, mandantId: DEMO.talwind };
const MIB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseDezimal', () => {
  it('deutsche Beträge, leer = kein Wert, alles andere ein Formatfehler', () => {
    expect(parseDezimal('1.234,56 €')).toBe(1234.56);
    expect(parseDezimal('1.234')).toBe(1234);
    expect(parseDezimal('\u2212 12,5')).toBe(-12.5);
    expect(parseDezimal('  ')).toBeNull();
    expect(parseDezimal('12,3,4')).toBe('fehler');
    expect(parseDezimal('1e9')).toBe('fehler');
    expect(parseDezimal('abc')).toBe('fehler');
  });
});

describe('koerperAusFormular', () => {
  const basis = () => {
    const a = tcmsFixtures.portalAufgabeK23Murat();
    a.kontrolle.kennzahlen = [
      { key: 'soll', label: 'Soll', differenzAus: null },
      { key: 'ist', label: 'Ist', differenzAus: null },
      { key: 'diff', label: 'Differenz', differenzAus: ['soll', 'ist'] },
    ] as never;
    return a;
  };

  it('Schritte nach dem Aufbau des Dienstes; Differenz ohne Wert; Ergebnis nur gültige Werte', () => {
    const r = koerperAusFormular(basis(), {
      schritt_0_erledigt: 'on',
      schritt_1_erledigt: 'true',
      schritt_5_erledigt: 'on',
      wert_soll: '1.000,00',
      wert_ist: '',
      wert_diff: '999',
      bemerkung_diff: ' erklärt ',
      erklaert_diff: 'on',
      ergebnis: 'GEFAELSCHT',
      ergebnisKommentar: ' ok ',
    });
    expect(r).toEqual({
      ok: true,
      body: {
        schritte: [
          { erledigt: true, kommentar: '' },
          { erledigt: false, kommentar: '' },
        ],
        werte: [
          { key: 'soll', wert: 1000, bemerkung: '', erklaert: false },
          { key: 'ist', wert: null, bemerkung: '', erklaert: false },
          { key: 'diff', wert: null, bemerkung: 'erklärt', erklaert: true },
        ],
        ergebnis: null,
        ergebnisKommentar: 'ok',
      },
    });
  });

  it('Betrag im falschen Format: Feldfehler je Kennzahl', () => {
    const r = koerperAusFormular(basis(), { wert_soll: '1,2,3', wert_ist: 'x' });
    expect(r).toMatchObject({
      ok: false,
      fieldErrors: { wert_soll: [BETRAG_FORMAT], wert_ist: [BETRAG_FORMAT] },
    });
  });
});

describe('koerperAusFormular – Basisregel der Freitexte (TCMS s8)', () => {
  it('NUL und einzelne Surrogate: Feldfehler mit dem Text des Vertrags, kein Body', () => {
    const a = tcmsFixtures.portalAufgabeK23Murat();
    const r = koerperAusFormular(a, {
      schritt_0_kommentar: 'erledigt\u0000',
      ergebnisKommentar: `ok ${String.fromCharCode(0xdc00)}`,
    });
    expect(r).toMatchObject({
      ok: false,
      fieldErrors: {
        schritt_0_kommentar: [TEXT_UNZULAESSIG_MELDUNG],
        ergebnisKommentar: [TEXT_UNZULAESSIG_MELDUNG],
      },
    });
    // Mehrzeilig und mit sichtbaren Sonderzeichen bleibt ein Freitext gültig.
    expect(
      koerperAusFormular(a, {
        schritt_0_kommentar: `Zeile 1\nZeile 2 ${String.fromCodePoint(0x1f600)}`,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('Zuständigkeit (Triage)', () => {
  it('nur K:/M: mit UUID; leer = keine Zuständigkeit', () => {
    expect(zuweisungAusFormular(`K:${DEMO.leon.toUpperCase()}`, 'f')).toEqual({
      id: DEMO.leon,
      art: 'KANZLEI',
    });
    expect(zuweisungAusFormular(`m:${DEMO.murat}`, 'f')).toEqual({
      id: DEMO.murat,
      art: 'MANDANT',
    });
    expect(zuweisungAusFormular('', 'f')).toBeNull();
    expect(zuweisungAusFormular(undefined, 'f')).toBeNull();
    for (const roh of [DEMO.leon, `X:${DEMO.leon}`, 'K:jemand', `K:${DEMO.leon} `]) {
      expect(() => zuweisungAusFormular(roh, 'f'), roh).toThrow(TcmsPersonUnzulaessig);
    }
  });

  it('Auswahl: nur aktive Mitarbeitende mit Zugriff auf den Mandanten', async () => {
    const findMany = vi.fn(async () => [
      { id: DEMO.anna.toUpperCase(), fullName: 'StB Dr. Anna Roth' },
      { id: DEMO.leon, fullName: 'Leon Brandt' },
      { id: DEMO.thomas, fullName: '  ' },
    ]);
    h.filter.mockResolvedValue(new Set([DEMO.anna, DEMO.thomas]));
    const r = await kanzleiPersonenAuswahlTx({ staffUser: { findMany } } as never, BEZUG);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: DEMO.tenant, active: true } }),
    );
    expect(h.filter).toHaveBeenCalledWith(
      expect.anything(),
      DEMO.tenant,
      [DEMO.anna, DEMO.leon, DEMO.thomas],
      DEMO.talwind,
    );
    expect(r).toEqual([{ wert: `K:${DEMO.anna}`, label: 'StB Dr. Anna Roth (Kanzlei)' }]);
  });

  it('Vorbelegung aus der Zuständigkeit der kanzleikonsole (älteste Zuordnung je Rolle)', async () => {
    const findMany = vi.fn(async () => [
      { role: 'HAUPTBEARBEITER', staffId: DEMO.leon },
      { role: 'BERUFSTRAEGER', staffId: DEMO.anna.toUpperCase() },
      { role: 'BERUFSTRAEGER', staffId: DEMO.thomas },
    ]);
    const r = await zustaendigkeitTx({ clientResponsibility: { findMany } } as never, BEZUG);
    expect(r).toEqual({ berufstraeger: `K:${DEMO.anna}`, hauptbearbeitung: `K:${DEMO.leon}` });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: DEMO.tenant, clientId: DEMO.talwind }),
      }),
    );
  });
});

describe('Texte', () => {
  it('Codefehler mit Restversuchen bzw. Sperre, nie mit Eingabe', () => {
    expect(codeFehlerText('CODE_FALSCH', 1)).toBe('Der Code stimmt nicht. Noch 1 Versuch.');
    expect(codeFehlerText('CODE_FALSCH', 0)).toMatch(/gesperrt/);
    expect(codeFehlerText('GESPERRT', 3)).toMatch(/gesperrt/);
  });

  it('Auswahlprüfung im Browser: Anzahl, Größe, Leere, zusammen', () => {
    const g = { maxDateien: 5, maxBytes: 10 * MIB, maxGesamt: 25 * MIB };
    expect(auswahlProblem([{ name: 'a', size: 1 }], g)).toBeNull();
    expect(
      auswahlProblem(
        Array.from({ length: 6 }, () => ({ name: 'a', size: 1 })),
        g,
      ),
    ).toMatch(/höchstens 5/);
    expect(auswahlProblem([{ name: 'gross.pdf', size: 10 * MIB + 1 }], g)).toMatch(/gross\.pdf/);
    expect(auswahlProblem([{ name: 'leer', size: 0 }], g)).toMatch(/leer/);
    expect(
      auswahlProblem(
        Array.from({ length: 3 }, () => ({ name: 'a', size: 9 * MIB })),
        g,
      ),
    ).toMatch(/Zusammen höchstens 25 MB/);
    expect(portalAnlageHinweis(g)).toBe(
      'höchstens 5 Dateien, je bis 10 MB, zusammen bis 25 MB (PDF, Bild, CSV, Text, Excel, Word, ZIP)',
    );
  });
});
