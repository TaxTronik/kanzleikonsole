// =============================================================================
// Stylesheet-Verträge von globals.css (B-08, Welle 15).
//
// jsdom wertet weder Tailwind-@apply noch @layer, Container-Queries oder
// forced-colors aus; diese Zusicherungen bleiben deshalb Prüfungen des
// Stylesheets — strukturiert über PostCSS (Selektor → Deklaration) statt über
// Textvergleiche. Gesammelt aus den früheren Quelltexttests
// accessibility-foundations, user-menu und datetime-picker-theme.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, type AtRule, type Container, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const APP_DIR = resolve(__dirname, '..');
const css = parse(readFileSync(join(APP_DIR, 'globals.css'), 'utf8'));

/** Kontext einer Regel: umschließende At-Regeln, z. B. ['@layer base']. */
function context(rule: Rule): string[] {
  const chain: string[] = [];
  for (let node: Container | undefined = rule.parent; node && node.type !== 'root'; ) {
    if (node.type === 'atrule') {
      const at = node as AtRule;
      chain.unshift(`@${at.name} ${at.params}`);
    }
    node = node.parent as Container | undefined;
  }
  return chain;
}

/** Regeln mit diesem Selektor (Selektorliste aufgeteilt) in genau diesem At-Kontext. */
function rules(selector: string, within: string[] = []): Rule[] {
  const found: Rule[] = [];
  css.walkRules((rule) => {
    const selectors = rule.selectors.map((part) => part.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector) && context(rule).join('|') === within.join('|')) {
      found.push(rule);
    }
  });
  return found;
}

/** Deklarationen eines Selektors in genau diesem At-Kontext, inkl. !important. */
function declarations(selector: string, within: string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rule of rules(selector, within)) {
    rule.walkDecls((decl) => {
      result[decl.prop] = `${decl.value}${decl.important ? ' !important' : ''}`;
    });
  }
  return result;
}

/** Utilities einer @apply-Regel im Selektor. */
function applied(selector: string, within: string[] = []): string[] {
  return rules(selector, within).flatMap((rule) =>
    (rule.nodes ?? [])
      .filter((node): node is AtRule => node.type === 'atrule' && node.name === 'apply')
      .flatMap((at) => at.params.split(/\s+/)),
  );
}

function relativeLuminance(rgb: string): number {
  const [r, g, b] = rgb.split(' ').map((channel) => {
    const value = Number(channel) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (light! + 0.05) / (dark! + 0.05);
}

describe('Fokus und Sekundärtext im Kontrastmodus (globale A11y-Grundlagen)', () => {
  it('hält gedämpften und deaktivierten Text hell wie dunkel bei mindestens 4,5:1', () => {
    const light = declarations(':root', ['@layer base']);
    const dark = declarations('.dark', ['@layer base']);
    expect(light['--text-muted']).toBe('108 101 96');
    expect(light['--text-disabled']).toBe('108 101 96');
    expect(dark['--text-disabled']).toBe('145 141 155');
    expect(contrastRatio('108 101 96', '233 231 226')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('145 141 155', '40 37 44')).toBeGreaterThanOrEqual(4.5);
  });

  it('zeigt im Forced-Colors-Modus einen Systemfarben-Fokusrahmen', () => {
    expect(
      declarations(
        ':where(a, button, input, select, textarea, summary, [tabindex]):focus-visible',
        ['@media (forced-colors: active)'],
      ).outline,
    ).toBe('2px solid Highlight !important');
  });

  it('färbt Primäraktionen über Tokens statt über fest angewendete Brand-Utilities', () => {
    expect(declarations('.btn-primary:focus-visible', ['@layer components'])['box-shadow']).toBe(
      '0 0 0 3px var(--ring)',
    );
    expect(declarations('.btn-primary', ['@layer components']).color).toBe(
      'rgb(var(--text-on-brand))',
    );
    expect(declarations('.settings-pill-save', ['@layer components']).color).toBe(
      'rgb(var(--text-on-brand))',
    );
    // Früher: `@apply bg-brand-600 text-white hover:bg-brand-700
    // focus-visible:ring-brand-500` — fest weißer Text und eigener Fokusring.
    const applies: string[] = [];
    css.walkAtRules('apply', (at) => {
      applies.push(at.params.replace(/\s+/g, ' '));
    });
    expect(applies.filter((params) => params.includes('bg-brand-600 text-white'))).toEqual([]);
    const utilities = applies.flatMap((params) => params.split(' '));
    expect(utilities).not.toContain('hover:bg-brand-700');
    expect(utilities).not.toContain('focus-visible:ring-brand-500');
  });

  it('gibt dem Schließen-Button der Dialoge eine 32-px-Zielfläche', () => {
    const close = declarations('.modal-close', ['@layer components']);
    expect(close.width).toBe('32px');
    expect(close.height).toBe('32px');
  });
});

describe('Konto-Menü', () => {
  it('zentriert den Avatar auch innerhalb vergrößerter Klickflächen', () => {
    expect(applied('.avatar-btn', ['@layer components'])).toEqual(
      expect.arrayContaining(['items-center', 'justify-center', 'shrink-0']),
    );
    expect(applied('.avatar', ['@layer components'])).toContain('shrink-0');
  });
});

describe('DateTimePicker-Popover (theme-aware Overlay)', () => {
  const calendar = '.taxtronik-datetime-calendar.react-datepicker';
  const timeList =
    '.taxtronik-datetime-calendar .react-datepicker__time-container .react-datepicker__time .react-datepicker__time-box ul.react-datepicker__time-list';

  it('ordnet Kalender und Uhrzeitliste im Grid statt per float an', () => {
    expect(declarations(calendar)).toMatchObject({
      'grid-template-columns': 'minmax(0, 15.5rem) 6rem',
      'align-items': 'start',
      'background-color': 'rgb(var(--surface-card))',
    });
    expect(declarations(timeList).height).toBe('16.25rem !important');
    // Hover der Uhrzeiten mit derselben Spezifität wie das Bibliotheks-CSS.
    expect(rules(`${timeList} li.react-datepicker__time-list-item:hover`)).toHaveLength(1);
  });

  it('stapelt auf schmalen Viewports einspaltig mit kürzerer Uhrzeitliste', () => {
    const narrow = ['@media (max-width: 380px)'];
    expect(declarations(calendar, narrow)['grid-template-columns']).toBe('minmax(0, 1fr)');
    expect(declarations(timeList, narrow).height).toBe('10rem !important');
  });
});
