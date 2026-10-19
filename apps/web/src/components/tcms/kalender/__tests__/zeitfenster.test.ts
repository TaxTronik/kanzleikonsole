// TCMS Stufe 3, Bereich B: Zeitfenster und Zuordnung des Kontrollkalenders
// (reine Anzeige; Status und Fälligkeit liefert der Dienst).
// Fachkatalog: TCMS-DIENST-001
import { describe, expect, it } from 'vitest';
import { imZeitraum, jeKontrolleUndMonat, monatKurz, zeitfenster } from '../zeitfenster';

describe('Zeitfenster des Kalenders', () => {
  it('ab gültigem Monat; sonst Wirksamkeitsbeginn im Jahresfenster; sonst Januar', () => {
    const z = zeitfenster('2026-03', '2026-10-19', null);
    expect(z.ab).toBe('2026-03');
    expect(z.schluessel[0]).toBe('2026-03');
    expect(z.schluessel).toHaveLength(12);
    expect(monatKurz(z.monate[11]!)).toBe('Feb 27');
    for (const ungueltig of ['2026-13', '2026-1', '26-01', '2026-00', 'x']) {
      expect(zeitfenster(ungueltig, '2026-10-19', null).ab).toBeNull();
    }
    expect(zeitfenster('', '2026-10-19', '2026-07-01T00:00:00.000Z').schluessel[0]).toBe('2026-07');
    // Wirksamkeitsbeginn länger als zwölf Monate vor dem Stichtag: Januar.
    expect(zeitfenster('', '2027-10-19', '2026-07-01T00:00:00.000Z').schluessel[0]).toBe('2027-01');
  });

  it('Zuordnung nach Fälligkeitsmonat und Wirksamkeitszeitraum', () => {
    const je = jeKontrolleUndMonat([
      { kontrolleId: 'k', faelligAm: '2026-10-10T00:00:00.000Z' },
      { kontrolleId: 'k', faelligAm: '2026-10-31T00:00:00.000Z' },
      { kontrolleId: 'k', faelligAm: 'kein Datum' },
    ] as never);
    expect(je.get('k|2026-10')).toHaveLength(2);
    expect(je.size).toBe(1);
    const monat = new Date(Date.UTC(2026, 6, 1));
    expect(imZeitraum(monat, '2026-07-15T00:00:00.000Z', '2026-12-31T00:00:00.000Z')).toBe(true);
    expect(imZeitraum(monat, null, '2026-12-31T00:00:00.000Z')).toBe(false);
  });
});
