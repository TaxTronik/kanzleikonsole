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

function hexToRgb(hex: string): RGB {
  const m = hex.replace('#', '').match(/^([\da-f]{6})$/i);
  if (!m) return { r: 37, g: 99, b: 235 }; // blue-600 fallback
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
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
  const baseRgb = hexToRgb(accentHex);
  const baseHsl = rgbToHsl(baseRgb);
  const out: Record<string, string> = {};
  for (const step of STEPS) {
    // Akzent (User-Wahl) selbst geht auf 600 — dort exakte Werte verwenden,
    // nicht Lightness-skaliert (sonst weicht es vom gewählten Farbton ab).
    const rgb = step.key === 600 ? baseRgb : withLightness(baseHsl, step.lightness);
    out[`--brand-${step.key}`] = `${rgb.r} ${rgb.g} ${rgb.b}`;
  }
  // Akzent als zusätzliche Variable für Sonderfälle
  out['--brand-accent'] = accentHex;
  return out;
}
