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
