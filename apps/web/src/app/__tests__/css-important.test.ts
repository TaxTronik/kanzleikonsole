// =============================================================================
// !important in den App-Stylesheets (Review C6).
//
// Von 34 !important-Deklarationen sind 17 übrig: nur noch dort, wo keine
// Spezifität hilft (Inline-Styles von react-datepicker, Fokus- und
// Bewegungs-Overrides der Barrierefreiheit, der kurze Theme-Übergang). Jede
// Fundstelle steht unten mit Grund; eine neue lässt den Test scheitern.
//
// Wo C6 !important durch Spezifität ersetzt hat, prüft der Test die
// Rangfolge: Die überstimmende Regel steht außerhalb jeder Cascade-Layer
// (schlägt damit Tailwinds Komponenten und Utilities) und ist spezifischer als
// die überstimmte — bei Gleichstand steht sie später in derselben Datei.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parse,
  type AtRule,
  type Container,
  type Declaration,
  type Document,
  type Rule,
} from 'postcss';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve(__dirname, '../..');
const FILES = [
  'app/globals.css',
  'app/accessible-display.css',
  'components/ui/grid-layout-edit.css',
];
const roots = Object.fromEntries(
  FILES.map((file) => [file, parse(readFileSync(join(SRC_DIR, file), 'utf8'))]),
);

const A11Y = "html:has([data-accessible-display='true'])";
const FOCUSABLE_A11Y =
  ":where( a, button, input, select, textarea, summary, [tabindex], [contenteditable='true'] ):focus-visible";
const REDUCED_MOTION = [
  "html:has([data-accessible-display='true'][data-accessible-reduce-motion='true'])",
  "html:has([data-accessible-display='true'][data-accessible-reduce-motion='true']) *",
  "html:has([data-accessible-display='true'][data-accessible-reduce-motion='true']) *::before",
  "html:has([data-accessible-display='true'][data-accessible-reduce-motion='true']) *::after",
].join(', ');
const TIME_LIST =
  '.taxtronik-datetime-calendar .react-datepicker__time-container .react-datepicker__time .react-datepicker__time-box ul.react-datepicker__time-list';

/** Verbleibende !important-Deklarationen mit Grund (Datei | @media | Selektor | Eigenschaft). */
const ALLOWED_IMPORTANT: Record<string, string> = {
  [`app/globals.css||${TIME_LIST}|height`]: 'react-datepicker setzt die Höhe als Inline-Style',
  [`app/globals.css|(max-width: 380px)|${TIME_LIST}|height`]: 'dito, schmale Ansicht',
  'app/globals.css||.theme-fade, .theme-fade *|transition':
    'Theme-Übergang schlägt 350 ms lang jede Komponenten-Transition',
  'app/globals.css|(forced-colors: active)|:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible|outline':
    'Systemfokus im Kontrastmodus schlägt jede Fokusregel inkl. Inline-Styles',
  'app/globals.css|(forced-colors: active)|:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible|outline-offset':
    'dito',
  'app/globals.css|(forced-colors: active)|:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible|box-shadow':
    'dito',
  [`app/accessible-display.css||${A11Y} ${FOCUSABLE_A11Y}|outline`]:
    'Fokusrahmen des Anzeigemodus schlägt Komponenten-Ringe und Inline-Styles',
  [`app/accessible-display.css||${A11Y} ${FOCUSABLE_A11Y}|outline-offset`]: 'dito',
  [`app/accessible-display.css||${A11Y} ${FOCUSABLE_A11Y}|box-shadow`]: 'dito',
  [`app/accessible-display.css||${REDUCED_MOTION}|animation-duration`]:
    'reduzierte Bewegung schlägt jede Animation inkl. Inline-Styles und .theme-fade',
  [`app/accessible-display.css||${REDUCED_MOTION}|animation-iteration-count`]: 'dito',
  [`app/accessible-display.css||${REDUCED_MOTION}|animation-delay`]: 'dito',
  [`app/accessible-display.css||${REDUCED_MOTION}|transition-duration`]: 'dito',
  [`app/accessible-display.css||${REDUCED_MOTION}|transition-delay`]: 'dito',
  [`app/accessible-display.css||${REDUCED_MOTION}|scroll-behavior`]: 'dito',
  [`app/accessible-display.css|(forced-colors: active)|${A11Y} ${FOCUSABLE_A11Y}|outline-color`]:
    'überstimmt den !important-Fokusrahmen mit der Systemfarbe',
  [`app/accessible-display.css|(forced-colors: active)|${A11Y} ${FOCUSABLE_A11Y}|box-shadow`]:
    'dito',
};

const normalize = (selector: string) => selector.replace(/\s+/g, ' ').trim();

function mediaOf(node: Rule): string {
  const media: string[] = [];
  let parent: Container | Document | undefined = node.parent;
  while (parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === 'media') {
      media.unshift((parent as AtRule).params);
    }
    parent = parent.parent as Container | Document | undefined;
  }
  return media.join(' ');
}

function layerOf(rule: Rule): string | null {
  let parent: Container | Document | undefined = rule.parent;
  while (parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === 'layer') {
      return (parent as AtRule).params;
    }
    parent = parent.parent as Container | Document | undefined;
  }
  return null;
}

function importantDeclarations(): string[] {
  const found: string[] = [];
  for (const [file, root] of Object.entries(roots)) {
    root.walkDecls((decl: Declaration) => {
      if (!decl.important) return;
      const rule = decl.parent as Rule;
      found.push(`${file}|${mediaOf(rule)}|${normalize(rule.selector)}|${decl.prop}`);
    });
  }
  return found;
}

/** Spezifität (a, b, c) für die Selektoren dieser Stylesheets (Selectors Level 4). */
function specificity(selector: string): [number, number, number] {
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  const add = ([x, y, z]: [number, number, number]) => {
    a += x;
    b += y;
    c += z;
  };
  const closing = (from: number, open: string, close: string) => {
    let depth = 0;
    for (let j = from; j < selector.length; j += 1) {
      if (selector[j] === open) depth += 1;
      if (selector[j] === close && --depth === 0) return j;
    }
    throw new Error(`Unvollständiger Selektor: ${selector}`);
  };
  const splitList = (list: string) => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let j = 0; j < list.length; j += 1) {
      if (list[j] === '(' || list[j] === '[') depth += 1;
      if (list[j] === ')' || list[j] === ']') depth -= 1;
      if (list[j] === ',' && depth === 0) {
        parts.push(list.slice(start, j));
        start = j + 1;
      }
    }
    return [...parts, list.slice(start)];
  };
  const max = (list: string) =>
    splitList(list)
      .map((part) => specificity(part.trim()))
      .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0]!;
  while (i < selector.length) {
    const char = selector[i]!;
    if (/[\s>+~*]/.test(char)) {
      i += 1;
    } else if (char === '#') {
      a += 1;
      i = /^#[\w-]+/.exec(selector.slice(i))![0].length + i;
    } else if (char === '.') {
      b += 1;
      i = /^\.[\w-]+/.exec(selector.slice(i))![0].length + i;
    } else if (char === '[') {
      b += 1;
      i = closing(i, '[', ']') + 1;
    } else if (selector.startsWith('::', i)) {
      c += 1;
      i = /^::[\w-]+/.exec(selector.slice(i))![0].length + i;
    } else if (char === ':') {
      const name = /^:([\w-]+)/.exec(selector.slice(i))![1]!;
      i += name.length + 1;
      let args: string | null = null;
      if (selector[i] === '(') {
        const end = closing(i, '(', ')');
        args = selector.slice(i + 1, end);
        i = end + 1;
      }
      if (name === 'where') continue;
      if ((name === 'is' || name === 'not' || name === 'has') && args !== null) add(max(args));
      else b += 1;
    } else {
      c += 1;
      i = /^[\w-]+/.exec(selector.slice(i))![0].length + i;
    }
  }
  return [a, b, c];
}

function compare(x: [number, number, number], y: [number, number, number]): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Erste ungeschichtete Regel mit genau diesem Selektor, die `prop` ohne !important setzt. */
function ruleFor(file: string, selector: string, prop: string, media = ''): Rule {
  let found: Rule | undefined;
  roots[file]!.walkRules((rule) => {
    if (found || normalize(rule.selector) !== selector || mediaOf(rule) !== media) return;
    if (rule.nodes.some((node) => node.type === 'decl' && node.prop === prop)) found = rule;
  });
  if (!found) throw new Error(`Regel fehlt: ${file} ${media} ${selector} { ${prop} }`);
  return found;
}

/**
 * Überstimmende und überstimmte Regel: [Datei, Selektor der Regel, @media,
 * passender Teil einer Selektorliste]. Verglichen wird der Teil, der das
 * betroffene Element trifft (ohne Angabe: der stärkste der Liste).
 */
type RuleRef = [file: string, selector: string, media?: string, match?: string];
type Override = [winner: RuleRef, loser: RuleRef, prop: string];

const G = 'app/globals.css';
const A = 'app/accessible-display.css';
const MOBILE = '(max-width: 767px)';
const GLASS_RESET = `${A11Y}:root :is(.card, .app-sidebar, .app-topbar, .settings-pill, .modal-backdrop)`;
const MOBILE_SIDEBAR = '.ui-modern aside.app-sidebar, .ui-modern.dark aside.app-sidebar';
const A11Y_SHELL = `${A11Y}:root .app-shell, ${A11Y}:root aside.app-sidebar`;

/** Seit C6 ohne !important: Rangfolge über Layer und Spezifität. */
const OVERRIDES: Override[] = [
  [[G, '.ui-modern .card:hover'], [G, '.ui-modern .card'], 'border-color'],
  [[G, '.ui-modern.dark .card'], [G, '.ui-modern .card'], 'background-color'],
  [
    [G, '.ui-modern.dark aside.app-sidebar'],
    [G, '.ui-modern aside.app-sidebar'],
    'background-color',
  ],
  [
    [G, MOBILE_SIDEBAR, MOBILE, '.ui-modern aside.app-sidebar'],
    [G, '.ui-modern aside.app-sidebar'],
    'background-color',
  ],
  [
    [G, MOBILE_SIDEBAR, MOBILE, '.ui-modern.dark aside.app-sidebar'],
    [G, '.ui-modern.dark aside.app-sidebar'],
    'background-color',
  ],
  [[A, `${A11Y}:root .card`], [G, '.ui-modern.dark .card'], 'background-color'],
  [
    [A, A11Y_SHELL, '', `${A11Y}:root .app-shell`],
    [G, '.ui-modern .app-shell'],
    'background-color',
  ],
  [
    [A, A11Y_SHELL, '', `${A11Y}:root aside.app-sidebar`],
    [G, '.ui-modern.dark aside.app-sidebar'],
    'background-color',
  ],
  [
    [A, A11Y_SHELL, '', `${A11Y}:root aside.app-sidebar`],
    [G, MOBILE_SIDEBAR, MOBILE, '.ui-modern.dark aside.app-sidebar'],
    'background-color',
  ],
  [[A, `${A11Y}:root body`], [G, '.ui-modern.dark body'], 'background-image'],
  [[A, `${A11Y} .settings-pill`], [G, '.ui-modern .settings-pill'], 'background-color'],
  [
    [A, `html.dark:has([data-accessible-display='true']) .settings-pill`],
    [G, '.ui-modern.dark .settings-pill'],
    'background-color',
  ],
  [[A, GLASS_RESET], [G, '.ui-modern .card'], 'backdrop-filter'],
  [[A, GLASS_RESET], [G, '.ui-modern aside.app-sidebar'], 'backdrop-filter'],
  [[A, GLASS_RESET], [G, '.ui-modern .app-topbar'], 'backdrop-filter'],
  [[A, GLASS_RESET], [G, '.ui-modern .settings-pill'], 'backdrop-filter'],
  [[A, GLASS_RESET], [G, '.ui-modern .modal-backdrop'], 'backdrop-filter'],
  [[A, `${A11Y} .card:hover`], [G, '.ui-modern .card:hover'], 'transform'],
];

/** Spezifität einer Selektorliste für ein Element, das alle Teile trifft: das Maximum. */
function strongest(selectorList: string): [number, number, number] {
  return selectorList
    .split(/,(?![^(]*\))/)
    .map((part) => specificity(part.trim()))
    .sort((x, y) => compare(y, x))[0]!;
}

describe('!important in den App-Stylesheets (C6)', () => {
  it('lässt nur die begründeten !important-Deklarationen zu', () => {
    const found = importantDeclarations();
    expect(found.filter((entry) => !(entry in ALLOWED_IMPORTANT))).toEqual([]);
    expect(Object.keys(ALLOWED_IMPORTANT).filter((entry) => !found.includes(entry))).toEqual([]);
    expect(found).toHaveLength(17);
  });

  it('rechnet die Spezifität nach Selectors Level 4', () => {
    expect(specificity('.ui-modern.dark aside.app-sidebar')).toEqual([0, 3, 1]);
    expect(specificity(`${A11Y}:root aside.app-sidebar`)).toEqual([0, 3, 2]);
    expect(specificity(GLASS_RESET)).toEqual([0, 3, 1]);
    expect(specificity(`${A11Y} :where(.card, .app-sidebar)`)).toEqual([0, 1, 1]);
    expect(
      specificity(
        ".taxtronik-datetime-calendar .react-datepicker__day--selected:not([aria-disabled='true']):hover",
      ),
    ).toEqual([0, 4, 0]);
    expect(specificity('ul.react-datepicker__time-list li::before')).toEqual([0, 1, 3]);
  });

  it.each(OVERRIDES)('%j gewinnt gegen %j bei %s ohne !important', (winner, loser, prop) => {
    const [winnerFile, winnerSelector, winnerMedia = '', winnerMatch] = winner;
    const [loserFile, loserSelector, loserMedia = '', loserMatch] = loser;
    const strong = ruleFor(winnerFile, winnerSelector, prop, winnerMedia);
    const weak = ruleFor(loserFile, loserSelector, prop, loserMedia);
    for (const rule of [strong, weak]) {
      rule.walkDecls(prop, (decl) => expect(decl.important).not.toBe(true));
    }
    // Ungeschichtet schlägt jede Cascade-Layer (Tailwind-Komponenten, Utilities).
    expect(layerOf(strong)).toBeNull();
    if (layerOf(weak) !== null) return;
    const order = compare(
      winnerMatch ? specificity(winnerMatch) : strongest(winnerSelector),
      loserMatch ? specificity(loserMatch) : strongest(loserSelector),
    );
    if (order === 0) {
      // Gleichstand nur innerhalb einer Datei: die spätere Regel gewinnt.
      expect(winnerFile).toBe(loserFile);
      expect(strong.source!.start!.offset).toBeGreaterThan(weak.source!.start!.offset);
    } else {
      expect(order).toBeGreaterThan(0);
    }
  });
});
