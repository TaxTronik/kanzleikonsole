import { describe, it, expect } from 'vitest';
import {
  readNormRefs,
  effectiveAnker,
  applyAddBerater,
  applyVerworfen,
  applyRemoveBerater,
  NormListChangedError,
  InvalidNormError,
  type CuratedNormRef,
} from '../norms-core';

const engine = (zitat: string, extra: Partial<CuratedNormRef> = {}): CuratedNormRef => ({
  zitat, id: null, titel: null, quelle: 'ENGINE', verworfen: false, ...extra,
});
const berater = (zitat: string, extra: Partial<CuratedNormRef> = {}): CuratedNormRef => ({
  zitat, id: null, titel: null, quelle: 'BERATER', verworfen: false, ...extra,
});

describe('readNormRefs', () => {
  it('normalisiert strukturierte Refs (Engine-Default, Berater erhalten, leere Zitate raus)', () => {
    const refs = readNormRefs(
      [
        { zitat: '§ 8 KStG', id: 'norm:KStG:8', titel: 'Einkommen' }, // ohne quelle → ENGINE
        { zitat: '§ 42 AO', quelle: 'BERATER', verworfen: false },
        { zitat: '  ', id: 'x' }, // leeres Zitat → gefiltert
        { zitat: '§ 146 AO', verworfen: true },
      ],
      [],
    );
    expect(refs).toEqual([
      { zitat: '§ 8 KStG', id: 'norm:KStG:8', titel: 'Einkommen', quelle: 'ENGINE', verworfen: false },
      { zitat: '§ 42 AO', id: null, titel: null, quelle: 'BERATER', verworfen: false },
      { zitat: '§ 146 AO', id: null, titel: null, quelle: 'ENGINE', verworfen: true },
    ]);
  });

  it('synthetisiert aus flachem normAnker, wenn keine strukturierten Refs vorliegen', () => {
    expect(readNormRefs(null, ['§ 1 EStG', '§ 2 EStG'])).toEqual([
      engine('§ 1 EStG'),
      engine('§ 2 EStG'),
    ]);
    // Nicht-Array (z. B. Json-Objekt) → ebenfalls Fallback.
    expect(readNormRefs({ foo: 1 }, ['§ 3 EStG'])).toEqual([engine('§ 3 EStG')]);
    expect(readNormRefs(null, [])).toEqual([]);
  });
});

describe('effectiveAnker', () => {
  it('lässt verworfene weg, dedupliziert, erhält die Reihenfolge', () => {
    const refs = [engine('§ 8 KStG'), engine('§ 146 AO', { verworfen: true }), berater('§ 42 AO'), engine('§ 8 KStG')];
    expect(effectiveAnker(refs)).toEqual(['§ 8 KStG', '§ 42 AO']);
  });
});

describe('applyAddBerater', () => {
  it('hängt eine Berater-Norm mit id/titel an', () => {
    const out = applyAddBerater([engine('§ 8 KStG')], { zitat: ' § 42 AO ', id: 'norm:AO:42', titel: 'Missbrauch' });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ zitat: '§ 42 AO', id: 'norm:AO:42', titel: 'Missbrauch', quelle: 'BERATER', verworfen: false });
  });

  it('weist leeres Zitat ab', () => {
    expect(() => applyAddBerater([], { zitat: '   ' })).toThrow(InvalidNormError);
  });

  it('weist Duplikate ab (gleiches, nicht verworfenes Zitat)', () => {
    expect(() => applyAddBerater([engine('§ 42 AO')], { zitat: '§ 42 AO' })).toThrow(InvalidNormError);
  });

  it('erlaubt Hinzufügen, wenn das gleiche Zitat nur als verworfen existiert', () => {
    const out = applyAddBerater([engine('§ 42 AO', { verworfen: true })], { zitat: '§ 42 AO' });
    expect(out).toHaveLength(2);
    expect(out[1]!.quelle).toBe('BERATER');
  });
});

describe('applyVerworfen', () => {
  it('setzt das Verwerfen-Flag am Zielindex', () => {
    const refs = [engine('§ 8 KStG'), engine('§ 146 AO')];
    const out = applyVerworfen(refs, { index: 1, zitat: '§ 146 AO' }, true);
    expect(out[1]!.verworfen).toBe(true);
    expect(out[0]!.verworfen).toBe(false);
    // Zurückholen
    expect(applyVerworfen(out, { index: 1, zitat: '§ 146 AO' }, false)[1]!.verworfen).toBe(false);
  });

  it('wirft bei Index/Zitat-Abweichung (Liste hat sich geändert)', () => {
    const refs = [engine('§ 8 KStG')];
    expect(() => applyVerworfen(refs, { index: 0, zitat: '§ 9 KStG' }, true)).toThrow(NormListChangedError);
    expect(() => applyVerworfen(refs, { index: 5, zitat: '§ 8 KStG' }, true)).toThrow(NormListChangedError);
  });
});

describe('applyRemoveBerater', () => {
  it('entfernt eine Berater-Norm', () => {
    const refs = [engine('§ 8 KStG'), berater('§ 42 AO')];
    expect(applyRemoveBerater(refs, { index: 1, zitat: '§ 42 AO' })).toEqual([engine('§ 8 KStG')]);
  });

  it('verweigert das Löschen eines Engine-Vorschlags (nur verwerfen erlaubt)', () => {
    const refs = [engine('§ 8 KStG')];
    expect(() => applyRemoveBerater(refs, { index: 0, zitat: '§ 8 KStG' })).toThrow(InvalidNormError);
  });

  it('wirft bei Zitat-Abweichung', () => {
    const refs = [berater('§ 42 AO')];
    expect(() => applyRemoveBerater(refs, { index: 0, zitat: '§ 43 AO' })).toThrow(NormListChangedError);
  });
});
