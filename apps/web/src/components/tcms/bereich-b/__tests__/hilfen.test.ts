// TCMS Stufe 3, Bereich B: gemeinsame Parameter- und Anzeigehilfen der Seiten
// (Query-Werte, Links, Sperre, Vier-Augen-Anzeige, Detail-Lesezugriff).
// Keine dieser Hilfen entscheidet fachlich; sie prüfen die Form von Eingaben
// oder wählen aus Kennzeichen des Dienstes aus.
// Fachkatalog: TCMS-DIENST-001
import { describe, expect, it, vi } from 'vitest';

// Die Texte kommen aus server/tcms/zustand (Kette bis zur Anmeldung).
vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
import { DEMO } from '@/__tests__/tcms-fixtures';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { detailAus, standQuery } from '../laden';
import {
  auswahlParam,
  mitStand,
  NUR_AKTUELL,
  objektIdParam,
  param,
  seitenLink,
  selbstBeantragt,
  sperreAus,
  standFuerLinks,
} from '../seite';

describe('Query-Parameter', () => {
  it('param: erster Wert, Mehrfachangaben zählen nicht, fehlend → leer', () => {
    expect(param({ a: ['x', 'y'] }, 'a')).toBe('x');
    expect(param({ a: 'z' }, 'a')).toBe('z');
    expect(param({}, 'a')).toBe('');
  });

  it('objektIdParam: nur IDs in der Form des Vertrags', () => {
    expect(objektIdParam({ r: 'cmvf9kyul0009wb7dw9t9diqc' }, 'r')).toBe(
      'cmvf9kyul0009wb7dw9t9diqc',
    );
    expect(objektIdParam({ r: 'EC-UST_01' }, 'r')).toBe('EC-UST_01');
    for (const boese of ['../x', 'a b', 'a/b', '', 'x'.repeat(65), 'ä', 'a?b=c']) {
      expect(objektIdParam({ r: boese }, 'r')).toBeNull();
    }
    expect(objektIdParam({ r: 'x'.repeat(64) }, 'r')).toBe('x'.repeat(64));
  });

  it('auswahlParam: nur Werte der festen Auswahl', () => {
    expect(auswahlParam({ p: 'KANZLEI' }, 'p', ['KANZLEI', 'MANDANT'] as const)).toBe('KANZLEI');
    expect(auswahlParam({ p: 'kanzlei' }, 'p', ['KANZLEI', 'MANDANT'] as const)).toBe('');
  });

  it('standQuery: nur ein gültiger Stichtag', () => {
    expect(standQuery({ stand: '2026-09-30' })).toEqual({ stand: '2026-09-30' });
    expect(standQuery({ stand: '2026-02-30' })).toEqual({});
    expect(standQuery({ stand: "2026-09-30' OR 1" })).toEqual({});
    expect(standQuery({})).toEqual({});
  });
});

describe('Links', () => {
  it('seitenLink: behaltene Werte plus Änderungen, leere entfallen, kodiert', () => {
    expect(seitenLink('/p', { stand: null, a: 'x' }, { b: 'y z', a: null })).toBe('/p?b=y+z');
    expect(seitenLink('/p', {}, {})).toBe('/p');
    expect(seitenLink('/p', { s: 'a&b=c' })).toBe('/p?s=a%26b%3Dc');
  });

  it('standFuerLinks/mitStand: Stichtag nur bei historischem Stand', () => {
    expect(standFuerLinks({ historisch: false, stand: '2026-10-19' })).toBeNull();
    expect(standFuerLinks({ historisch: true, stand: '2026-06-30' })).toBe('2026-06-30');
    expect(mitStand('/a', null)).toBe('/a');
    expect(mitStand('/a', '2026-06-30')).toBe('/a?stand=2026-06-30');
    expect(mitStand('/a?x=1', '2026-06-30')).toBe('/a?x=1&stand=2026-06-30');
  });
});

describe('Sperre und Vier-Augen-Anzeige', () => {
  it('sperreAus: historischer Stand vor fehlendem Recht; sonst bedienbar', () => {
    expect(sperreAus({ historisch: true, rechte: { bearbeiten: true } })).toBe(NUR_AKTUELL);
    expect(sperreAus({ historisch: true, rechte: { bearbeiten: false } })).toBe(NUR_AKTUELL);
    expect(sperreAus({ historisch: false, rechte: { bearbeiten: false } })).toBe(
      TCMS_KEIN_RECHT.BEARBEITEN,
    );
    expect(sperreAus({ historisch: false, rechte: { bearbeiten: true } })).toBeNull();
  });

  it('selbstBeantragt: gleiche Person unabhängig von Groß-/Kleinschreibung, nie bei fehlenden Angaben', () => {
    expect(selbstBeantragt(DEMO.anna, DEMO.anna.toUpperCase())).toBe(true);
    expect(selbstBeantragt(DEMO.anna, DEMO.leon)).toBe(false);
    expect(selbstBeantragt(DEMO.anna, null)).toBe(false);
    expect(selbstBeantragt(null, DEMO.anna)).toBe(false);
    expect(selbstBeantragt('', '')).toBe(false);
  });
});

describe('detailAus', () => {
  it('kein Detail, Fehler als Zustand, 404 als kein Detail', () => {
    expect(detailAus(null)).toBeNull();
    expect(detailAus({ ok: true, daten: null, requestId: null })).toBeNull();
    expect(detailAus({ ok: true, daten: { a: 1 }, requestId: null })).toEqual({
      ok: true,
      daten: { a: 1 },
    });
    expect(
      detailAus({ ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: 'x' } } as never),
    ).toEqual({ ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: 'x' } });
  });
});
