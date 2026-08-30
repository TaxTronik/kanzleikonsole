import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../app/accessible-display.css'), 'utf8');
const root = parse(css);
const modeSelector = "html:has([data-accessible-display='true'])";

function rules() {
  const result: Rule[] = [];
  root.walkRules((rule) => {
    result.push(rule);
  });
  return result;
}

function declarations(rule: Rule) {
  const result: Record<string, string> = {};
  rule.walkDecls((declaration) => {
    result[declaration.prop] = declaration.value;
  });
  return result;
}

function luminance(rgb: string) {
  const [red, green, blue] = rgb.split(' ').map((channel) => {
    const value = Number(channel) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(first: string, second: string) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('persönlicher Anzeigemodus: CSS-Vertrag, keine Konformitätsprüfung', () => {
  it('wendet Schrift, Abstand, Kontrast und Bewegung nur nach der jeweiligen Profiloption an', () => {
    const font = rules().find(
      (rule) =>
        rule.selector ===
        "html:has([data-accessible-display='true'][data-accessible-font-size='extra-large'])",
    )!;
    expect(declarations(font)['font-size']).toBe('125%');
    const spacing = rules().find(
      (rule) =>
        rule.selector ===
        "html:has([data-accessible-display='true'][data-accessible-spacing='wide'])",
    )!;
    expect(declarations(spacing)['--accessible-line-height']).toBe('1.8');
    for (const rule of rules()) {
      const values = declarations(rule);
      if (values['--text-primary'])
        expect(rule.selector).toContain("[data-accessible-contrast='strong']");
      if (values['animation-duration'])
        expect(rule.selector).toContain("[data-accessible-reduce-motion='true']");
    }
  });
  it('hält große portalisierte Menüs innerhalb des verfügbaren Viewports scrollbar', () => {
    const menu = rules().find((rule) => rule.selector === `${modeSelector} .user-dropdown`)!;
    expect(declarations(menu)).toMatchObject({
      position: 'relative',
      inset: 'auto',
      'overflow-y': 'auto',
      'overscroll-behavior': 'contain',
    });
    expect(declarations(menu)['max-block-size']).toContain(
      '--radix-dropdown-menu-content-available-height',
    );
    expect(declarations(menu)['max-block-size']).toContain('100dvh');
    expect(css).toContain('scroll-padding-block: 0.5rem');
  });
  it('aktiviert jede Regel nur über den servergerenderten Profilmarker und schließt Portale ein', () => {
    expect(rules().length).toBeGreaterThan(20);
    for (const rule of rules()) {
      // PostCSS trennt vollständige Selektoren, nicht die Kommas in :where().
      for (const selector of rule.selectors) {
        expect(selector).toMatch(
          /^html(?:\.dark)?:has\(\[data-accessible-display='true'\](?:\[data-accessible-[^\]]+\])?\)/,
        );
      }
    }
  });

  for (const [name, selector] of [
    ['hell', "html:has([data-accessible-display='true'][data-accessible-contrast='strong'])"],
    [
      'dunkel',
      "html.dark:has([data-accessible-display='true'][data-accessible-contrast='strong'])",
    ],
  ]) {
    it(`hält neutrale Texte >=7:1 und Begrenzungen >=3:1 auf allen ${name}en Flächen`, () => {
      const tokenRule = rules().find((rule) => rule.selector === selector);
      expect(tokenRule).toBeDefined();
      const tokens = declarations(tokenRule!);
      const surfaces = Object.keys(tokens).filter((key) => key.startsWith('--surface-'));
      expect(surfaces).toHaveLength(5);
      for (const surface of surfaces) {
        for (const text of ['primary', 'secondary', 'muted', 'disabled']) {
          expect(contrast(tokens[`--text-${text}`]!, tokens[surface]!)).toBeGreaterThanOrEqual(7);
        }
        for (const border of ['default', 'strong', 'subtle']) {
          expect(contrast(tokens[`--border-${border}`]!, tokens[surface]!)).toBeGreaterThanOrEqual(
            3,
          );
        }
      }
    });
  }

  it('vergrößert gemeinsame px-basierte Texte und zentrale Ziele ohne globalen Layout-Zoom', () => {
    const typography = rules().find((rule) => rule.selector.includes('.ud-head .uname'))!;
    expect(typography.selector).toContain('.btn-primary');
    expect(typography.selector).toContain('.hint');
    expect(declarations(typography)).toMatchObject({
      'font-size': '1rem',
      'line-height': 'var(--accessible-line-height)',
    });
    expect(css).toContain('font-size: 112.5%');
    expect(css).toContain('min-block-size: 44px');
    expect(css).toContain('min-inline-size: 44px');
    root.walkDecls((declaration) => {
      expect(declaration.prop).not.toBe('zoom');
      expect(declaration.prop).not.toBe('scale');
      expect(declaration.value).not.toMatch(/^scale\(/);
    });
  });

  it('markiert Textlinks und Fokus unabhängig von der tenantabhängigen Inline-Markenfarbe', () => {
    expect(css).toContain('text-decoration-line: underline');
    expect(css).toContain('outline: 3px solid rgb(var(--accessible-focus)) !important');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('outline-color: Highlight !important');
    root.walkDecls((declaration) => {
      expect(declaration.prop).not.toMatch(/^--brand-/);
      expect(declaration.prop).not.toBe('--text-on-brand');
      expect(declaration.prop).not.toBe('forced-color-adjust');
    });
  });

  it('reduziert CSS-Bewegung und Glas, erhält funktionale Transforms und sichtbare Inhalte', () => {
    expect(css).toContain('animation-duration: 0.01ms !important');
    expect(css).toContain('animation-iteration-count: 1 !important');
    expect(css).toContain('transition-duration: 0.01ms !important');
    expect(css).toContain('backdrop-filter: none !important');
    expect(css).toContain('background-color: rgb(var(--surface-card)) !important');
    expect(css).toContain('background-color: rgb(var(--surface-topbar)) !important');
    // :root erhöht die Spezifität über die Glas-Overrides von .ui-modern.dark.
    expect(css).toContain(`${modeSelector}:root .card`);
    expect(css).toContain(`${modeSelector}:root aside.app-sidebar`);
    expect(css).toContain(`${modeSelector}:root main .sticky`);
    for (const rule of rules()) {
      const values = declarations(rule);
      expect(values.display).not.toBe('none');
      expect(values.visibility).not.toBe('hidden');
      expect(values.opacity).not.toBe('0');
      if (values.transform === 'none') {
        expect(
          rule.selector.includes('.card:hover') ||
            (rule.selector.includes(':not(.dashboard-edit)') &&
              rule.selector.includes('.react-grid-item:has(> .widget-shell)')),
        ).toBe(true);
      }
    }
  });

  it('lässt größere Toolbar-/Header-Inhalte umbrechen, statt sie global abzuschneiden', () => {
    expect(css).toContain("[role='toolbar']");
    expect(css).toContain('flex-wrap: wrap');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('flex-basis: 100%');
    expect(css).toContain('scroll-padding-block-start: 8rem');
    expect(css).not.toContain('overflow-x: hidden');
    expect(css).not.toContain('overflow: hidden');
  });

  it('stapelt das schmale Dashboard nur in der Leseansicht, ohne Edit- oder Fremdraster umzubauen', () => {
    const mobile = root.nodes.find(
      (node) =>
        node.type === 'atrule' && node.name === 'media' && node.params === '(max-width: 640px)',
    );
    expect(mobile).toBeDefined();
    const gridRules = rules().filter((rule) => rule.selector.includes('.react-grid-layout'));
    expect(gridRules).toHaveLength(5);
    for (const rule of gridRules) {
      expect(rule.parent).toBe(mobile);
      for (const selector of rule.selectors) {
        expect(selector).toContain(':not(.dashboard-edit)');
        expect(selector).toContain('.widget-shell');
      }
    }
    expect(declarations(gridRules[0]!)).toMatchObject({
      display: 'grid',
      'grid-template-columns': 'minmax(0, 1fr)',
      height: 'auto',
    });
    expect(declarations(gridRules[1]!)).toMatchObject({
      position: 'static',
      transform: 'none',
      width: '100%',
      height: 'auto',
    });
    expect(css).toContain('.app-shell > main > :where(.p-6, .p-8)');
    expect(css).toContain(':where(.card.p-6, .card.p-8, .card.p-12)');
    expect(css).toContain('padding: 1rem');
  });

  it('lässt KPI-Labels umbrechen und lange Inhalte im festen Desktop-Raster lokal scrollen', () => {
    const label = rules().find(
      (rule) => rule.selector === `${modeSelector} .widget-shell > a.card .truncate`,
    )!;
    expect(declarations(label)).toMatchObject({
      'white-space': 'normal',
      overflow: 'visible',
      'overflow-wrap': 'anywhere',
      'text-overflow': 'clip',
    });
    const card = rules().find(
      (rule) => rule.selector === `${modeSelector} .widget-shell > a.card`,
    )!;
    expect(declarations(card)).toMatchObject({ overflow: 'auto' });
  });
});
