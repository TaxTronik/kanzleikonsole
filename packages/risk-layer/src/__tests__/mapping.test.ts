import { describe, it, expect } from 'vitest';
import { mapAnalyse } from '../mapping';

// Aus einer echten Engine-Antwort (v1.0.0 / Katalog 0.3.0) abgeleitet.
const real = {
  text_hash: 'abc123',
  katalog_version: '0.3.0',
  engineVersion: '1.0.0',
  karten: [
    {
      start: 4,
      end: 35,
      matched_text: 'Kasse wurde nicht ordnungsgemäß',
      begriff: 'Mängel der Buchführung / Kassenführung',
      begriff_id: 'ao_kasse',
      status: 'treffer',
      ist_streitig: true,
      governance_typ: 'FF',
      schadensintensitaet: 'hoch',
      kaskadenreichweite: 2,
      via: 'muster',
      herkunft: { schicht: '1b', methode: 'deterministisch' },
      norm_anker: [{ zitat: '§ 146 AO', ids: ['norm:AO:146'] }, { zitat: '§ 158 AO' }],
      normketten: [{ glieder: ['§ 146 AO', '§ 158 AO'], verknuepfung: '→', hinweis: 'Ordnungsmangel' }],
    },
    {
      start: 79,
      end: 107,
      matched_text: 'verdeckte Gewinnausschüttung',
      begriff: 'verdeckte Gewinnausschüttung',
      begriff_id: 'kst_vga',
      governance_typ: 'IN',
      schadensintensitaet: 'hoch',
      via: 'wörtlich',
      herkunft: { schicht: '1' },
      norm_anker: [{ zitat: '§ 8 Abs. 3 Satz 2 KStG' }],
      normketten: [],
    },
  ],
  risiken: [
    {
      start: 36,
      end: 43,
      matched_text: 'geführt',
      titel: '§ 8 HGB',
      status: 'unknown_risiko',
      governance_typ: null,
      schadensintensitaet: 'mittel',
      quelle: 'trigger',
      herkunft: { schicht: '1.5' },
      norm_anker: [],
      norm_vorschlag: [{ zitat: '§ 8 HGB' }, { zitat: '§ 23 HGB' }],
    },
  ],
  spans: [{ start: 79, end: 107, ref: { type: 'karte', index: 1 } }],
  summary: { anzahl: 3 },
  audit: { ok: true },
};

describe('mapAnalyse (echte Engine-Form)', () => {
  it('liest snake_case text_hash/katalog_version + engineVersion', () => {
    const r = mapAnalyse(real);
    expect(r.textHash).toBe('abc123');
    expect(r.katalogVersion).toBe('0.3.0');
    expect(r.engineVersion).toBe('1.0.0');
  });

  it('mappt karten + risiken zu Markierungen, sortiert nach Position', () => {
    const r = mapAnalyse(real);
    expect(r.markings).toHaveLength(3);
    expect(r.markings.map((m) => m.start)).toEqual([4, 36, 79]);
  });

  it('leitet Herkunft aus via/schicht ab', () => {
    const r = mapAnalyse(real);
    const at = (s: number) => r.markings.find((m) => m.start === s)!;
    expect(at(4).herkunft).toBe('MUSTER');
    expect(at(79).herkunft).toBe('WOERTLICH');
    expect(at(36).herkunft).toBe('TRIGGER');
  });

  it('normalisiert Governance/Stufe, extrahiert Normanker (zitat) + Normketten', () => {
    const k = mapAnalyse(real).markings.find((m) => m.start === 4)!;
    expect(k.governanceTyp).toBe('FF');
    expect(k.schadensintensitaet).toBe('HOCH');
    expect(k.kaskadenreichweite).toBe(2);
    expect(k.begriffId).toBe('ao_kasse');
    expect(k.normAnker).toEqual(['§ 146 AO', '§ 158 AO']);
    expect(k.normketten).toEqual([
      { glieder: ['§ 146 AO', '§ 158 AO'], verknuepfung: '→', hinweis: 'Ordnungsmangel' },
    ]);
  });

  it('übernimmt engineStatus + streitig', () => {
    const r = mapAnalyse(real);
    const at = (s: number) => r.markings.find((m) => m.start === s)!;
    expect(at(4).engineStatus).toBe('treffer');
    expect(at(4).streitig).toBe(true);
    expect(at(36).engineStatus).toBe('unknown_risiko');
    expect(at(79).streitig).toBe(false);
  });

  it('Risiko nutzt titel als Begriff und norm_vorschlag als Anker', () => {
    const ri = mapAnalyse(real).markings.find((m) => m.start === 36)!;
    expect(ri.begriff).toBe('§ 8 HGB');
    expect(ri.begriffId).toBeNull();
    expect(ri.governanceTyp).toBeNull();
    expect(ri.normAnker).toEqual(['§ 8 HGB', '§ 23 HGB']);
  });

  it('normRefs normalisiert beide Engine-Varianten (id-String vs. ids[]) inkl. Titel', () => {
    const r = mapAnalyse({
      ...real,
      risiken: [
        {
          ...real.risiken[0],
          norm_vorschlag: [{ zitat: '§ 8 KStG', id: 'norm:KStG:8', titel: 'Ermittlung des Einkommens' }],
        },
      ],
    });
    // Karte: ids[] → erste ID; Eintrag ohne ID → id null.
    const k = r.markings.find((m) => m.start === 4)!;
    expect(k.normRefs).toEqual([
      { zitat: '§ 146 AO', id: 'norm:AO:146', titel: null },
      { zitat: '§ 158 AO', id: null, titel: null },
    ]);
    // Risiko: singular id + titel durchgereicht.
    const ri = r.markings.find((m) => m.start === 36)!;
    expect(ri.normRefs).toEqual([
      { zitat: '§ 8 KStG', id: 'norm:KStG:8', titel: 'Ermittlung des Einkommens' },
    ]);
  });

  it('rawResult bleibt unverändert; leere Antwort → keine Markierungen', () => {
    expect(mapAnalyse(real).rawResult).toBe(real);
    const empty = mapAnalyse({ text_hash: 'h' });
    expect(empty.markings).toEqual([]);
    expect(empty.katalogVersion).toBe('unbekannt');
    expect(empty.engineVersion).toBe('unbekannt');
  });
});
