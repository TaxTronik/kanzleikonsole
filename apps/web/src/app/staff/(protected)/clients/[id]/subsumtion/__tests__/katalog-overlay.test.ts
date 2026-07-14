import { describe, it, expect } from 'vitest';
import { buildKatalogOverlay, katalogStatus } from '../_ui';

describe('buildKatalogOverlay + katalogStatus', () => {
  const overlay = buildKatalogOverlay({
    verworfen: ['norm:AO:162'],
    ergaenzt: [
      { zitat: '§ 90 AO', id: 'norm:AO:90' },
      { zitat: '§ 200 AO', id: null }, // ergänzt nur per Zitat (keine ID)
    ],
  });

  it('verworfen über Norm-ID', () => {
    expect(katalogStatus({ id: 'norm:AO:162', zitat: '§ 162 AO' }, overlay)).toBe('verworfen');
  });

  it('ergaenzt über Norm-ID', () => {
    expect(katalogStatus({ id: 'norm:AO:90', zitat: '§ 90 AO' }, overlay)).toBe('ergaenzt');
  });

  it('ergaenzt über Zitat, wenn keine ID vorliegt', () => {
    expect(katalogStatus({ id: null, zitat: '§ 200 AO' }, overlay)).toBe('ergaenzt');
  });

  it('null, wenn die Norm nicht im Katalog kuratiert ist', () => {
    expect(katalogStatus({ id: 'norm:EStG:4', zitat: '§ 4 EStG' }, overlay)).toBeNull();
  });

  it('null ohne Overlay (Endpoint noch nicht geladen/verfügbar)', () => {
    expect(katalogStatus({ id: 'norm:AO:162', zitat: '§ 162 AO' }, null)).toBeNull();
  });

  it('verworfen hat Vorrang, falls dieselbe Norm verworfen UND ergänzt gelistet wäre', () => {
    const o = buildKatalogOverlay({
      verworfen: ['norm:X'],
      ergaenzt: [{ zitat: 'X', id: 'norm:X' }],
    });
    expect(katalogStatus({ id: 'norm:X', zitat: 'X' }, o)).toBe('verworfen');
  });
});
