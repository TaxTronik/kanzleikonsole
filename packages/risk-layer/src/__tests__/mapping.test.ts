import { describe, it, expect } from 'vitest';
import { mapAnalyse, RiskMappingError } from '../mapping';

const baseSpan = {
  start: 0,
  end: 5,
  matchedText: 'Hallo',
  herkunft: 'woertlich',
  begriffId: 'b1',
  begriff: 'Kassenführung',
  normAnker: ['§ 146 AO', '§ 158 AO'],
  normketten: [{ glieder: ['§ 146 AO', '§ 158 AO'], verknuepfung: 'und', hinweis: 'Kaskade' }],
  governanceTyp: 'fp',
  schadensintensitaet: 'hoch',
  wahrscheinlichkeit: 'moeglich',
  kaskadenreichweite: 2,
};

const base = {
  textHash: 'abc123',
  katalogVersion: 'k-2026.1',
  engineVersion: 'e-1.0',
  spans: [baseSpan],
};

describe('mapAnalyse', () => {
  it('normalisiert Engine-Klein-Enums auf Domänen-UPPERCASE und erhält Anker/Ketten', () => {
    const r = mapAnalyse(base);
    expect(r.textHash).toBe('abc123');
    expect(r.katalogVersion).toBe('k-2026.1');
    expect(r.markings).toHaveLength(1);
    const m = r.markings[0]!;
    expect(m.herkunft).toBe('WOERTLICH');
    expect(m.governanceTyp).toBe('FP');
    expect(m.schadensintensitaet).toBe('HOCH');
    expect(m.wahrscheinlichkeit).toBe('MOEGLICH');
    expect(m.kaskadenreichweite).toBe(2);
    expect(m.normAnker).toEqual(['§ 146 AO', '§ 158 AO']);
    expect(m.normketten).toEqual([
      { glieder: ['§ 146 AO', '§ 158 AO'], verknuepfung: 'und', hinweis: 'Kaskade' },
    ]);
  });

  it('reicht den unveränderten Engine-Output als rawResult durch', () => {
    const r = mapAnalyse(base);
    expect(r.rawResult).toBe(base);
  });

  it('engineVersion fällt auf "unbekannt" zurück, wenn das Feld fehlt', () => {
    const r = mapAnalyse({ textHash: 'h', katalogVersion: 'k', spans: [baseSpan] });
    expect(r.engineVersion).toBe('unbekannt');
  });

  it('wirft RiskMappingError bei unbekannter Provenienz', () => {
    const bad = { ...base, spans: [{ ...baseSpan, herkunft: 'zauberei' }] };
    expect(() => mapAnalyse(bad)).toThrow(RiskMappingError);
  });

  it('mappt unbekannte/leere Governance-Werte auf null (kein harter Fehler)', () => {
    const r = mapAnalyse({
      ...base,
      spans: [{ ...baseSpan, governanceTyp: 'xx', schadensintensitaet: '', wahrscheinlichkeit: undefined }],
    });
    const m = r.markings[0]!;
    expect(m.governanceTyp).toBeNull();
    expect(m.schadensintensitaet).toBeNull();
    expect(m.wahrscheinlichkeit).toBeNull();
  });

  it('liefert leere Markierungsliste bei fehlendem spans', () => {
    const r = mapAnalyse({ textHash: 'h', katalogVersion: 'k' });
    expect(r.markings).toEqual([]);
  });
});
