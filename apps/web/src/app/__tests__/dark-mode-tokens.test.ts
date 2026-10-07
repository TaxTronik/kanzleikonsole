// =============================================================================
// Dark Mode: EIN Mechanismus (Review K-07).
//
// Status- und Brand-Stufen werden über property-spezifische Theme-Variablen
// themeabhängig (`--text-color-red-700: var(--dark-text-red-700, …)`), nicht
// mehr über ungeschichtete `.dark .text-red-700 { … }`-Regeln. Diese schlugen
// jede Utility in @layer utilities — explizite `dark:`-Klassen am selben
// Element blieben wirkungslos, Brand-Text brauchte !important.
//
// Der Test sichert ab:
//   - keine ungeschichtete Regel mehr, die eine Farb-Utility übersteuert,
//   - jede früher übersteuerte Utility hat ihren Dark-Wert als Token, und
//     eine explizite dark:-Klasse gewinnt gegen ihn,
//   - die Dark-Werte bleiben lesbar (kein hell-auf-hell),
//   - die C6-Erweiterung (Statustexte unter 4,5:1 im Dark) hält hell wie
//     dunkel 4,5:1 auf den Flächen, auf denen diese Texte stehen,
//   - der Glas-Selektor der Topbar trifft nur noch `.app-topbar`.
// =============================================================================

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type AtRule, type Container, type Document, type Rule } from 'postcss';
import { __unstable__loadDesignSystem } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const APP_DIR = resolve(__dirname, '..');
const GLOBALS_CSS = join(APP_DIR, 'globals.css');
const css = readFileSync(GLOBALS_CSS, 'utf8');
const root = parse(css);

/** Die 33 Utilities, die bis K-07 per `.dark .<utility>` übersteuert wurden. */
const FORMERLY_OVERRIDDEN = {
  'bg-brand-50': '--dark-bg-brand-50',
  'bg-brand-100': '--dark-bg-brand-100',
  'text-brand-500': '--dark-text-brand',
  'text-brand-600': '--dark-text-brand',
  'text-brand-700': '--dark-text-brand',
  'text-brand-900': '--dark-text-brand',
  'bg-yellow-50': '--dark-bg-yellow-50',
  'bg-yellow-100': '--dark-bg-yellow-100',
  'text-yellow-700': '--dark-text-yellow-700',
  'text-yellow-800': '--dark-text-yellow-800',
  'bg-emerald-50': '--dark-bg-emerald-50',
  'bg-emerald-100': '--dark-bg-emerald-100',
  'text-emerald-700': '--dark-text-emerald-700',
  'text-emerald-800': '--dark-text-emerald-800',
  'text-emerald-900': '--dark-text-emerald-900',
  'bg-red-50': '--dark-bg-red-50',
  'bg-red-100': '--dark-bg-red-100',
  'bg-red-200': '--dark-bg-red-200',
  'text-red-700': '--dark-text-red-700',
  'text-red-800': '--dark-text-red-800',
  'text-red-900': '--dark-text-red-900',
  'bg-amber-50': '--dark-bg-amber-50',
  'text-amber-600': '--dark-text-amber-600',
  'text-amber-700': '--dark-text-amber-700',
  'text-amber-800': '--dark-text-amber-800',
  'text-amber-900': '--dark-text-amber-900',
  'bg-blue-50': '--dark-bg-blue-50',
  'text-blue-600': '--dark-text-blue-600',
  'text-blue-700': '--dark-text-blue-700',
  'bg-purple-50': '--dark-bg-purple-50',
  'text-purple-700': '--dark-text-purple-700',
  'border-yellow-200': '--dark-border-yellow-200',
  'border-amber-200': '--dark-border-amber-200',
} as const;

/** Statustext auf seiner hellen Statusfläche — im Dark beide als Token. */
const DARK_PAIRS: Array<[text: string, surface: string]> = [
  ['--dark-text-red-700', '--dark-bg-red-50'],
  ['--dark-text-red-800', '--dark-bg-red-100'],
  ['--dark-text-red-900', '--dark-bg-red-200'],
  ['--dark-text-amber-600', '--dark-bg-amber-50'],
  ['--dark-text-amber-700', '--dark-bg-amber-50'],
  ['--dark-text-amber-800', '--dark-bg-amber-50'],
  ['--dark-text-amber-900', '--dark-bg-amber-50'],
  ['--dark-text-yellow-700', '--dark-bg-yellow-50'],
  ['--dark-text-yellow-800', '--dark-bg-yellow-100'],
  ['--dark-text-emerald-700', '--dark-bg-emerald-50'],
  ['--dark-text-emerald-800', '--dark-bg-emerald-100'],
  ['--dark-text-emerald-900', '--dark-bg-emerald-100'],
  ['--dark-text-blue-600', '--dark-bg-blue-50'],
  ['--dark-text-blue-700', '--dark-bg-blue-50'],
  ['--dark-text-purple-700', '--dark-bg-purple-50'],
];

/** Hellste und dunkelste Dark-Fläche (surface-raised, surface-sunken). */
const DARK_SURFACES = [
  [40, 37, 44],
  [13, 11, 15],
] as const;

/**
 * C6: Statustexte, die im Dark unter 4,5:1 lagen (Palettenwert auf
 * surface-raised: red-500 3,96, red-600 3,16, green-700 3,05, green-800 2,12,
 * green-900 1,67, emerald-600 4,13, yellow-900 1,74, blue-800 1,71,
 * blue-900 1,46, purple-800 1,70, pink-800 1,91, indigo-700 1,87,
 * violet-600 2,56, teal-600 4,11). `light` ist die Palettenstufe des
 * Fallbacks (≥ 4,5:1 auf card, page und raised), `tints` die Statusflächen,
 * auf denen der Text im Code steht — hell als Palette, dunkel als Token.
 */
const C6_TEXT_TOKENS: Record<string, { light: string; tints: readonly string[] }> = {
  'red-500': { light: 'red-700', tints: ['red-50', 'red-100'] },
  'red-600': { light: 'red-700', tints: ['red-50', 'red-100'] },
  'green-700': { light: 'green-800', tints: ['green-50'] },
  'green-800': { light: 'green-800', tints: ['green-50'] },
  'green-900': { light: 'green-900', tints: ['green-50'] },
  'emerald-600': { light: 'emerald-700', tints: ['emerald-50', 'emerald-100'] },
  'yellow-900': { light: 'yellow-900', tints: ['yellow-50', 'yellow-100'] },
  'blue-800': { light: 'blue-800', tints: ['blue-50', 'blue-100'] },
  'blue-900': { light: 'blue-900', tints: ['blue-50', 'blue-100'] },
  'purple-800': { light: 'purple-800', tints: ['purple-50', 'purple-100'] },
  'pink-800': { light: 'pink-800', tints: ['pink-100'] },
  'indigo-700': { light: 'indigo-700', tints: ['indigo-50'] },
  'violet-600': { light: 'violet-600', tints: [] },
  'teal-600': { light: 'teal-700', tints: [] },
};

/** C6: helle Statusflächen dieser Texte, die im Dark bisher hell blieben. */
const C6_BG_TOKENS = ['green-50', 'amber-100', 'blue-100', 'purple-100', 'pink-100', 'indigo-50'];

/** Tailwind-v4-Palette (oklch) → sRGB, für die hellen Fallbacks. */
const THEME_CSS = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
function paletteRgb(shade: string): Rgba {
  const match = THEME_CSS.match(
    new RegExp(`--color-${shade}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
  );
  if (!match) throw new Error(`Palettenstufe fehlt: ${shade}`);
  const [lightness, chroma, hue] = [Number(match[1]) / 100, Number(match[2]), Number(match[3])];
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (value: number) => {
    const clamped = Math.min(1, Math.max(0, value));
    return Math.round(
      255 * (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055),
    );
  };
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    1,
  ];
}

/** Helle Flächen aus :root (card, page, raised), auf denen Statustext steht. */
function lightSurfaces(): Array<[number, number, number]> {
  const surfaces: Array<[number, number, number]> = [];
  root.walkRules((rule) => {
    if (rule.selector !== ':root' || layerOf(rule) !== 'base') return;
    rule.walkDecls(/^--surface-(?:card|page|raised)$/, (decl) => {
      const [r, g, b] = decl.value.split(/\s+/).map(Number);
      surfaces.push([r!, g!, b!]);
    });
  });
  return surfaces;
}

type Rgba = [number, number, number, number];

function parseRgb(value: string): Rgba {
  const match = value.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (!match) throw new Error(`Unerwarteter Farbwert: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
}

function composite([r, g, b, a]: Rgba, [br, bg, bb]: readonly number[]): [number, number, number] {
  return [r * a + br! * (1 - a), g * a + bg! * (1 - a), b * a + bb! * (1 - a)];
}

function contrast(first: readonly number[], second: readonly number[]): number {
  const luminance = (rgb: readonly number[]) => {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [a, b] = [luminance(first), luminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function layerOf(rule: Rule): string | null {
  let node: Container | Document | undefined = rule.parent;
  while (node) {
    if (node.type === 'atrule' && (node as AtRule).name === 'layer') return (node as AtRule).params;
    node = node.parent as Container | Document | undefined;
  }
  return null;
}

function darkTokens(): Record<string, string> {
  const tokens: Record<string, string> = {};
  root.walkRules((rule) => {
    if (!rule.selectors.includes('.dark') || layerOf(rule) !== 'base') return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--dark-')) tokens[decl.prop] = decl.value;
    });
  });
  return tokens;
}

describe('Dark Mode über Status-Tokens statt globaler Overrides (K-07)', () => {
  let design: Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

  beforeAll(async () => {
    design = await __unstable__loadDesignSystem(css, {
      base: APP_DIR,
      async loadStylesheet(id, base) {
        const file = id.startsWith('.')
          ? resolve(base, id)
          : require.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id);
        return { path: file, base: dirname(file), content: readFileSync(file, 'utf8') };
      },
      async loadModule(id, base) {
        const file = resolve(base, id);
        const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
        return { path: file, base: dirname(file), module: (loaded.default ?? loaded) as never };
      },
    });
  }, 60_000);

  it('enthält keine ungeschichtete Regel mehr, die eine Farb-Utility übersteuert', () => {
    const offenders: string[] = [];
    root.walkRules((rule) => {
      if (layerOf(rule)) return;
      if (/\.(?:bg|text|border|divide|ring)-[a-z]+(?:-\d+)?(?![\w-])/.test(rule.selector)) {
        offenders.push(rule.selector);
      }
    });
    expect(offenders).toEqual([]);
    expect(css).not.toMatch(/\.text-brand-[\w-]+[^{]*\{[^}]*!important/);
  });

  it.each(Object.entries(FORMERLY_OVERRIDDEN))(
    '%s schaltet über das Token %s und lässt dark:-Klassen gewinnen',
    (utility, token) => {
      const base = design.candidatesToCss([utility])[0]!.replace(/\s+/g, '');
      expect(base).toContain(`var(${token},`);
      expect(base).not.toContain('.dark');
      expect(darkTokens()[token]).toMatch(/^rgb\(/);
      // Explizite dark:-Klasse: eigene Regel mit höherer Spezifität im selben Layer.
      const property = utility.split('-')[0]!;
      const [explicit] = design.candidatesToCss([`dark:${property}-gray-900`]);
      expect(explicit).toContain(':is(.dark *)');
    },
  );

  it('hält Statustexte im Dark auf ihren Flächen und auf allen Dark-Flächen lesbar', () => {
    const tokens = darkTokens();
    for (const [text, surface] of DARK_PAIRS) {
      const fg = parseRgb(tokens[text]!);
      for (const page of DARK_SURFACES) {
        const background = composite(parseRgb(tokens[surface]!), page);
        expect(contrast(composite(fg, background), background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(composite(fg, page), page)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(Object.entries(C6_TEXT_TOKENS))(
    'text-%s hält über sein C6-Token hell wie dunkel 4,5:1',
    (shade, { light, tints }) => {
      const token = `--dark-text-${shade}`;
      const base = design.candidatesToCss([`text-${shade}`])[0]!.replace(/\s+/g, '');
      expect(base).toContain(`var(${token},var(--color-${light}))`);
      expect(base).not.toContain('.dark');
      const tokens = darkTokens();
      expect(tokens[token]).toMatch(/^rgb\(\d+ \d+ \d+\)$/);

      // Dunkel: auf den Extremflächen und auf den getönten Statusflächen.
      const fg = parseRgb(tokens[token]!);
      for (const page of DARK_SURFACES) {
        expect(contrast(composite(fg, page), page)).toBeGreaterThanOrEqual(4.5);
        for (const tint of tints) {
          const surface = composite(parseRgb(tokens[`--dark-bg-${tint}`]!), page);
          expect(
            contrast(composite(fg, surface), surface),
            `${shade} auf ${tint}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      // Hell: Fallback-Stufe auf card, page, raised und den hellen Statusflächen.
      const lightFg = paletteRgb(light);
      const surfaces = lightSurfaces();
      expect(surfaces).toHaveLength(3);
      for (const surface of [...surfaces, ...tints.map((tint) => paletteRgb(tint))]) {
        expect(contrast(lightFg, surface), `${light} hell`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(C6_BG_TOKENS)('bg-%s wird im Dark zur getönten Fläche (C6)', (shade) => {
    const base = design.candidatesToCss([`bg-${shade}`])[0]!.replace(/\s+/g, '');
    expect(base).toContain(`var(--dark-bg-${shade},var(--color-${shade}))`);
    expect(darkTokens()[`--dark-bg-${shade}`]).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.\d+\)$/);
    // Explizite dark:-Klassen am Element gewinnen weiterhin.
    expect(design.candidatesToCss([`dark:bg-${shade}`])[0]).toContain(':is(.dark *)');
  });

  it('löst Brand-Tokens am Tenant-Wrapper auf und bleibt im Light beim AA-Markentext', () => {
    expect(css).toMatch(
      /\.dark,\s*\.dark \.app-shell \{[^}]*--dark-text-brand: rgb\(var\(--brand-text-dark\)\)/,
    );
    expect(design.candidatesToCss(['text-brand-accessible'])[0]).toContain(
      'rgb(var(--brand-text-light))',
    );
    expect(design.candidatesToCss(['text-brand-300'])[0]).toContain('--brand-300');
  });

  it('beschränkt den Glas-Selektor der Topbar auf .app-topbar', () => {
    const selectors: string[] = [];
    root.walkRules((rule) => {
      selectors.push(...rule.selectors);
    });
    expect(selectors.filter((selector) => /\.sticky(?![\w-])/.test(selector))).toEqual([]);
    expect(css).toMatch(/\.ui-modern \.app-topbar \{/);
    for (const layout of ['staff/(protected)/layout.tsx', 'portal/(protected)/layout.tsx']) {
      const source = readFileSync(join(APP_DIR, layout), 'utf8');
      expect(source).toMatch(/className="app-topbar [^"]*sticky top-0/);
    }
  });
});
