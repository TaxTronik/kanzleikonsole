import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { brandContrastInfo, brandPaletteStyle, contrastRatio } from '../brand-palette';

describe('barrierefreie Brand-Palette', () => {
  it.each(['#000000', '#ffffff', '#2563eb', '#facc15', '#22c55e', '#777777'])(
    'wählt auf %s eine Textfarbe mit mindestens 4,5:1 Kontrast',
    (accent) => {
      const info = brandContrastInfo(accent);

      expect(info.onBrandContrast).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(info.onBrandHex, accent)).toBeCloseTo(info.onBrandContrast, 5);
    },
  );

  it.each(['#000000', '#ffffff', '#2563eb', '#facc15', '#a855f7'])(
    'erzeugt für %s einen Fokusfarbton mit mindestens 3:1 auf hellen und dunklen Flächen',
    (accent) => {
      const info = brandContrastInfo(accent);

      expect(info.focusContrastOnLight).toBeGreaterThanOrEqual(3);
      expect(info.focusContrastOnDark).toBeGreaterThanOrEqual(3);
    },
  );

  it('hält die Text- und Fokusgrenzen für beliebige RGB-Markenfarben ein', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
        ),
        ([red, green, blue]) => {
          const accent = `#${[red, green, blue]
            .map((channel) => channel.toString(16).padStart(2, '0'))
            .join('')}`;
          const info = brandContrastInfo(accent);

          return (
            info.onBrandContrast >= 4.5 &&
            info.focusContrastOnLight >= 3 &&
            info.focusContrastOnDark >= 3 &&
            info.textOnLightContrast >= 4.5 &&
            info.textOnDarkContrast >= 4.5
          );
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('bewahrt die Markenfarbe und liefert semantische Kontrastvariablen aus', () => {
    const style = brandPaletteStyle('#facc15');

    expect(style['--brand-600']).toBe('250 204 21');
    expect(style['--brand-accent']).toBe('#facc15');
    expect(style['--text-on-brand']).toBe('0 0 0');
    expect(style['--brand-focus']).toMatch(/^\d+ \d+ \d+$/);
    expect(style['--brand-text-light']).toMatch(/^\d+ \d+ \d+$/);
    expect(style['--brand-text-dark']).toMatch(/^\d+ \d+ \d+$/);
    expect(style['--ring']).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });

  it('hält Brand-Text auch auf vertieften und hervorgehobenen Light-Flächen lesbar', () => {
    const info = brandContrastInfo('#2563eb');

    expect(contrastRatio(info.textOnLightHex, '#e9e7e2')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(info.textOnLightHex, '#f0efec')).toBeGreaterThanOrEqual(4.5);
  });

  it('fällt bei ungültigen Eingaben kontrolliert auf die Standardfarbe zurück', () => {
    const style = brandPaletteStyle('keine-farbe');

    expect(style['--brand-accent']).toBe('#2563eb');
    expect(style['--brand-600']).toBe('37 99 235');
  });
});
