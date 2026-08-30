// =============================================================================
// Brand-Palette-Generator
//
// Aus einem Hex-Akzentfarbcode wie "#2563eb" wird eine 6-stufige Skala
// erzeugt (50/100/500/600/700/900) — analog Tailwind. Verwenden:
//
//   <div style={brandPaletteStyle('#7c3aed')}>...
//
// Algorithmus: HSL-konvertieren, Lightness anpassen für jede Stufe.
// Sättigung bleibt erhalten, Hue auch — gibt einen "tonalen Match".
// =============================================================================

interface RGB {
  r: number;
  g: number;
  b: number;
}
interface HSL {
  h: number;
  s: number;
  l: number;
}

const DEFAULT_ACCENT = '#2563eb';
const BLACK: RGB = { r: 0, g: 0, b: 0 };
const WHITE: RGB = { r: 255, g: 255, b: 255 };
// Dunkelste reguläre Light-Mode-Fläche. Brand-Text wird für helle Oberflächen
// abgedunkelt; besteht er hier, besteht er auch auf den helleren Page-, Card-
// und Hover-Flächen.
const LIGHT_TEXT_SURFACE: RGB = { r: 233, g: 231, b: 226 };
// Hellste reguläre Dark-Mode-Fläche; wer hier besteht, besteht auch auf den
// dunkleren Page-/Card-Flächen.
const DARK_SURFACE: RGB = { r: 40, g: 37, b: 44 };

export interface BrandContrastInfo {
  accentHex: string;
  onBrandHex: '#000000' | '#ffffff';
  onBrandContrast: number;
  blackContrast: number;
  whiteContrast: number;
  focusHex: string;
  focusContrastOnLight: number;
  focusContrastOnDark: number;
  textOnLightHex: string;
  textOnLightContrast: number;
  textOnDarkHex: string;
  textOnDarkContrast: number;
}

function normalizeHex(hex: string): string {
  const value = hex.trim();
  return /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_ACCENT;
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(normalizeHex(hex).slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex({ r, g, b }: RGB): string {
  const channel = (value: number) => value.toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function relativeLuminance({ r, g, b }: RGB): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function rgbContrastRatio(first: RGB, second: RGB): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Berechnet das WCAG-Kontrastverhältnis zweier Hex-Farben. */
export function contrastRatio(firstHex: string, secondHex: string): number {
  return rgbContrastRatio(hexToRgb(firstHex), hexToRgb(secondHex));
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  const t = (n: number) => {
    if (n < 0) n += 1;
    if (n > 1) n -= 1;
    if (n < 1 / 6) return p + (q - p) * 6 * n;
    if (n < 1 / 2) return q;
    if (n < 2 / 3) return p + (q - p) * (2 / 3 - n) * 6;
    return p;
  };
  return {
    r: Math.round(t(hk + 1 / 3) * 255),
    g: Math.round(t(hk) * 255),
    b: Math.round(t(hk - 1 / 3) * 255),
  };
}

function withLightness(base: HSL, l: number): RGB {
  return hslToRgb({ ...base, l });
}

/**
 * Ein mittlerer Leuchtdichtewert macht den Fokusindikator auf den hellen und
 * dunklen Standardflächen sichtbar. Der Farbton der Kanzlei bleibt erhalten;
 * nur die Helligkeit wird per Binärsuche auf die Ziel-Luminanz gebracht.
 */
function focusColor(base: HSL): RGB {
  const targetLuminance = 0.2;
  let low = 0;
  let high = 1;
  let candidate = withLightness(base, 0.5);
  for (let index = 0; index < 24; index += 1) {
    const lightness = (low + high) / 2;
    candidate = withLightness(base, lightness);
    if (relativeLuminance(candidate) < targetLuminance) low = lightness;
    else high = lightness;
  }
  return candidate;
}

/**
 * Hält den gewählten Markenfarbton für Wortmarken so weit wie möglich
 * unverändert. Reicht sein Kontrast nicht, wird nur die Helligkeit bis zur
 * WCAG-AA-Grenze verschoben: auf hellen Flächen dunkler, auf dunklen heller.
 */
function readableAccentColor(accent: RGB, background: RGB, lighten: boolean): RGB {
  const targetContrast = 4.5;
  if (rgbContrastRatio(accent, background) >= targetContrast) return accent;

  const base = rgbToHsl(accent);
  let low = lighten ? base.l : 0;
  let high = lighten ? 1 : base.l;
  let candidate = accent;

  for (let index = 0; index < 24; index += 1) {
    const lightness = (low + high) / 2;
    const current = withLightness(base, lightness);
    const passes = rgbContrastRatio(current, background) >= targetContrast;
    if (lighten) {
      if (passes) high = lightness;
      else low = lightness;
    } else if (passes) {
      low = lightness;
    } else {
      high = lightness;
    }
    candidate = withLightness(base, lighten ? high : low);
  }

  return candidate;
}

/**
 * Liefert die tatsächlich eingesetzten Kontrastwerte für Vorschau und Tests.
 * Für Text auf der exakten Akzentfarbe wird automatisch Schwarz oder Weiß
 * gewählt — je nachdem, welche Variante den höheren Kontrast erreicht.
 */
export function brandContrastInfo(accentHex: string): BrandContrastInfo {
  const normalizedAccent = normalizeHex(accentHex);
  const accent = hexToRgb(normalizedAccent);
  const blackContrast = rgbContrastRatio(accent, BLACK);
  const whiteContrast = rgbContrastRatio(accent, WHITE);
  const useBlack = blackContrast >= whiteContrast;
  const focus = focusColor(rgbToHsl(accent));
  const textOnLight = readableAccentColor(accent, LIGHT_TEXT_SURFACE, false);
  const textOnDark = readableAccentColor(accent, DARK_SURFACE, true);
  return {
    accentHex: normalizedAccent,
    onBrandHex: useBlack ? '#000000' : '#ffffff',
    onBrandContrast: useBlack ? blackContrast : whiteContrast,
    blackContrast,
    whiteContrast,
    focusHex: rgbToHex(focus),
    focusContrastOnLight: rgbContrastRatio(focus, WHITE),
    focusContrastOnDark: rgbContrastRatio(focus, DARK_SURFACE),
    textOnLightHex: rgbToHex(textOnLight),
    textOnLightContrast: rgbContrastRatio(textOnLight, LIGHT_TEXT_SURFACE),
    textOnDarkHex: rgbToHex(textOnDark),
    textOnDarkContrast: rgbContrastRatio(textOnDark, DARK_SURFACE),
  };
}

const STEPS: Array<{ key: 50 | 100 | 500 | 600 | 700 | 900; lightness: number }> = [
  { key: 50, lightness: 0.97 },
  { key: 100, lightness: 0.92 },
  { key: 500, lightness: 0.6 },
  { key: 600, lightness: 0.5 },
  { key: 700, lightness: 0.4 },
  { key: 900, lightness: 0.22 },
];

/**
 * Liefert ein React-style-Object mit allen --brand-*-CSS-Variablen.
 * Auf den Layout-Wrapper anwenden:
 *
 *   <div style={brandPaletteStyle(branding.accentColor)}>...
 */
export function brandPaletteStyle(accentHex: string): Record<string, string> {
  const contrast = brandContrastInfo(accentHex);
  const baseRgb = hexToRgb(contrast.accentHex);
  const baseHsl = rgbToHsl(baseRgb);
  const out: Record<string, string> = {};
  for (const step of STEPS) {
    // Akzent (User-Wahl) selbst geht auf 600 — dort exakte Werte verwenden,
    // nicht Lightness-skaliert (sonst weicht es vom gewählten Farbton ab).
    const rgb = step.key === 600 ? baseRgb : withLightness(baseHsl, step.lightness);
    out[`--brand-${step.key}`] = `${rgb.r} ${rgb.g} ${rgb.b}`;
  }
  const onBrand = hexToRgb(contrast.onBrandHex);
  const focus = hexToRgb(contrast.focusHex);
  const textOnLight = hexToRgb(contrast.textOnLightHex);
  const textOnDark = hexToRgb(contrast.textOnDarkHex);
  // Semantische Variablen für Text auf Brand-Flächen sowie einen soliden
  // Fokusindikator, der auf hellen und dunklen Standardflächen ≥ 3:1 hält.
  out['--text-on-brand'] = `${onBrand.r} ${onBrand.g} ${onBrand.b}`;
  out['--brand-focus'] = `${focus.r} ${focus.g} ${focus.b}`;
  out['--brand-text-light'] = `${textOnLight.r} ${textOnLight.g} ${textOnLight.b}`;
  out['--brand-text-dark'] = `${textOnDark.r} ${textOnDark.g} ${textOnDark.b}`;
  out['--ring'] = `rgb(${focus.r} ${focus.g} ${focus.b})`;
  // Akzent als zusätzliche Variable für Sonderfälle
  out['--brand-accent'] = contrast.accentHex;
  return out;
}
