// =============================================================================
// Tailwind-Klassen-Guard: Klassen, die kein CSS erzeugen, fallen im Test auf.
//
// Tailwind v4 übergeht unbekannte Klassen stillschweigend. So blieben
// `hover:text-secondary` (Token nur als Klasse in `@layer utilities`),
// `border-brand-200` (Brand-Stufe fehlte) oder `border-default/60` ohne
// jede Wirkung, und `@apply text-muted` brach den Build (Review F-15).
//
// Der Test lädt globals.css mit Tailwinds eigenem Compiler (inkl. @config) und
// prüft jeden Klassen-Kandidaten aus den String-Literalen von src/**:
//   1. Token- und Brand-Familien (bg-surface*, border-default|strong|subtle,
//      text-primary|secondary|muted|disabled, *-brand-<Stufe>, divide-border-*,
//      brand-wordmark) müssen IMMER CSS erzeugen — mit jeder Variante und
//      jedem Modifier.
//   2. Alle übrigen Farb-Utilities (bg-, text-, border-, divide-, ring-, …)
//      ebenso; Ausnahme sind nur einfache Klassen, die globals.css bzw.
//      accessible-display.css selbst definieren, und die unten dokumentierten
//      Altlasten (bekannt, aber nicht Teil dieses Fixes).
//   3. Die Brand-Stufen sind in tailwind.config.ts, :root und
//      brandPaletteStyle() identisch.
// =============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __unstable__loadDesignSystem, compile } from 'tailwindcss';
import * as ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { BRAND_STEPS } from '@/lib/brand-palette';

const require = createRequire(import.meta.url);
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = resolve(APP_DIR, '..');
const GLOBALS_CSS = join(APP_DIR, 'globals.css');
const CSS_FILES = [GLOBALS_CSS, join(APP_DIR, 'accessible-display.css')];

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;
type CompileOptions = NonNullable<Parameters<typeof compile>[1]>;

/** Lädt @import/@config wie @tailwindcss/postcss, nur mit direkten Abhängigkeiten. */
const loaders: CompileOptions = {
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
};

/** Strikte Familien: die semantischen Tokens und alle Brand-Stufen. */
const TOKEN_FAMILY =
  /^-?(?:(?:bg-surface(?:-page|-raised|-sunken|-topbar)?)|(?:border(?:-[trblxyse])?|divide)-(?:default|strong|subtle)|text-(?:primary|secondary|muted|disabled)|divide-border-(?:default|subtle)|brand-wordmark|(?:bg|text|border(?:-[trblxyse])?|divide|ring(?:-offset)?|outline|fill|stroke|decoration|placeholder|caret|accent|from|via|to|shadow)-brand-\d+)(?:\/\d+)?$/;

/** Farbfähige Utility-Wurzeln für die breite Prüfung. */
const COLOR_FAMILY =
  /^-?(?:bg|text|border(?:-[trblxyse])?|divide|ring(?:-offset)?|outline|fill|stroke|decoration|placeholder|caret|accent)-[a-z0-9]/;

/**
 * Bekannte Altlasten außerhalb von F-15: Klassennamen, die nie definiert
 * waren und deshalb bis heute kein CSS erzeugen. Neue Fundstellen (andere
 * Datei oder neue Klasse) lassen den Test scheitern. Die Bereinigung braucht
 * eine Gestaltungsentscheidung (welche Fläche ist "subtle", welches Rot ist
 * "danger"?) und wird separat erledigt; danach den Eintrag hier löschen.
 */
const KNOWN_UNRESOLVED: Record<string, readonly string[]> = {
  'bg-subtle': [
    'app/gwg-onboarding/wizard-steps.tsx',
    'app/staff/(protected)/clients/[id]/gwg/beneficial-owner-form.tsx',
    'app/staff/(protected)/clients/[id]/gwg/evidence-form-toggle.tsx',
    'app/staff/(protected)/clients/[id]/gwg/gwg-page-evidence.tsx',
    'app/staff/(protected)/clients/[id]/gwg/gwg-page-overview.tsx',
    'app/staff/(protected)/clients/[id]/gwg/gwg-page-status.tsx',
    'app/staff/(protected)/clients/[id]/gwg/identity-document-review.tsx',
    'app/staff/(protected)/clients/[id]/gwg/invite-section.tsx',
    'app/staff/(protected)/clients/[id]/gwg/start-check-cycle-form.tsx',
    'components/gwg/identity-capture.tsx',
  ],
  'border-border-subtle': [
    'app/staff/(protected)/clients/[id]/notices/new/page.tsx',
    'app/staff/(protected)/clients/[id]/subsumtion/research-view.tsx',
    'app/staff/(protected)/inbox/attachment-review.tsx',
    'app/staff/(protected)/reminders/[id]/ticket-context.tsx',
  ],
  '[&_hr]:border-border-subtle': [
    'app/staff/(protected)/clients/[id]/subsumtion/research-results-block.tsx',
    'components/document-preview.tsx',
  ],
  'bg-border-subtle': [
    'app/staff/(protected)/clients/[id]/subsumtion/editor-toolbar.tsx',
    'app/staff/(protected)/knowledge/rich-markdown-editor.tsx',
  ],
  'border-primary': ['app/staff/(protected)/clients/[id]/subsumtion/new-marking-panel.tsx'],
  'text-brand': [
    'app/staff/(protected)/clients/[id]/subsumtion/norm-ref-editor.tsx',
    'app/staff/(protected)/clients/[id]/workflows/start-form.tsx',
    'app/staff/(protected)/dashboard/widgets/personal.tsx',
  ],
  'hover:text-brand': ['app/staff/(protected)/clients/[id]/subsumtion/norm-ref-editor.tsx'],
  'text-danger': ['components/form-errors.tsx'],
  'hover:text-danger': ['app/staff/(protected)/admin/settings/route-editor-section.tsx'],
  'text-success': ['app/staff/(protected)/inbox/[id]/page.tsx'],
};

interface Candidate {
  token: string;
  file: string;
  line: number;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Utility-Teil eines Kandidaten (ohne Varianten und !important). */
function utilityOf(token: string): string {
  const parts = token.split(/:(?![^[]*\])/);
  return parts[parts.length - 1]!.replace(/^!|!$/g, '');
}

/** Alle Tokens aus String- und Template-Literalen (keine Kommentare, kein JSX-Text). */
function collectCandidates(): Candidate[] {
  const result: Candidate[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, 'utf8');
    const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
    const rel = relative(SRC_DIR, file).split(sep).join('/');
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        for (const token of node.text.split(/\s+/)) {
          if (token) result.push({ token, file: rel, line });
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
}

function plainCssClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of CSS_FILES) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      classes.add(match[1]!);
    }
  }
  return classes;
}

describe('Tailwind-Klassen erzeugen CSS (F-15)', () => {
  let design: DesignSystem;
  let candidates: Candidate[];
  const cache = new Map<string, boolean>();
  const generatesCss = (token: string): boolean => {
    let known = cache.get(token);
    if (known === undefined) {
      known = design.candidatesToCss([token])[0] !== null;
      cache.set(token, known);
    }
    return known;
  };

  beforeAll(async () => {
    design = await __unstable__loadDesignSystem(readFileSync(GLOBALS_CSS, 'utf8'), loaders);
    candidates = collectCandidates();
  }, 120_000);

  it('findet die Kandidaten der Token- und Brand-Familien (Plausibilität)', () => {
    const tokens = candidates.filter((c) => TOKEN_FAMILY.test(utilityOf(c.token)));
    expect(tokens.length).toBeGreaterThan(1_000);
    expect(tokens.some((c) => c.token === 'hover:text-secondary')).toBe(true);
    expect(tokens.some((c) => /^border-brand-200$/.test(c.token))).toBe(true);
  });

  it('erzeugt für jede Token-/Brand-Klasse CSS — auch mit Varianten und Modifiern', () => {
    const failures = candidates
      .filter((c) => TOKEN_FAMILY.test(utilityOf(c.token)) && !/[[\]{}$]/.test(utilityOf(c.token)))
      .filter((c) => !generatesCss(c.token))
      .map((c) => `${c.file}:${c.line} ${c.token}`);
    expect(failures).toEqual([]);
  });

  it('meldet unbekannte Farb-Utilities außerhalb der dokumentierten Altlasten', () => {
    const plain = plainCssClasses();
    const failures: string[] = [];
    for (const c of candidates) {
      const utility = utilityOf(c.token);
      if (!COLOR_FAMILY.test(utility) || /[[\]{}$]/.test(utility)) continue;
      if (generatesCss(c.token)) continue;
      if (utility === c.token && plain.has(utility)) continue;
      if (KNOWN_UNRESOLVED[c.token]?.includes(c.file)) continue;
      failures.push(`${c.file}:${c.line} ${c.token}`);
    }
    expect(failures).toEqual([]);
  });

  it('löst die Tokens auch über @apply auf (ersetzt den früheren @apply-Guard)', async () => {
    const css = `${readFileSync(GLOBALS_CSS, 'utf8')}
.guard-apply {
  @apply bg-surface-raised text-muted border-default hover:text-secondary dark:text-disabled border-strong/60 divide-border-subtle bg-brand-950/10;
}`;
    const output = (await compile(css, loaders)).build([]);
    const applied = output.slice(output.indexOf('.guard-apply {'));
    expect(applied).toContain('background-color: rgb(var(--surface-raised));');
    expect(applied).toContain('color: rgb(var(--text-secondary));');
    expect(applied).toContain('rgb(var(--border-strong)) 60%');
    expect(design.candidatesToCss(['hover:text-secondary'])[0]).toContain(
      'color: rgb(var(--text-secondary))',
    );
    expect(design.candidatesToCss(['border-default/60'])[0]).toContain(
      'rgb(var(--border-default)) 60%',
    );
    // Property-spezifisch: keine sinnfreien Querklassen aus den Tokens.
    expect(design.candidatesToCss(['bg-primary', 'text-surface', 'ring-default'])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('führt dieselben elf Brand-Stufen in Config, :root und brandPaletteStyle()', async () => {
    const steps = BRAND_STEPS.map((step) => String(step.key));
    expect(steps).toEqual([
      '50',
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
      '700',
      '800',
      '900',
      '950',
    ]);
    const config = (await import('../../../tailwind.config')).default as {
      theme: { extend: { colors: { brand: Record<string, string> } } };
    };
    expect(Object.keys(config.theme.extend.colors.brand)).toEqual(steps);
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    const rootDefaults = [...css.matchAll(/--brand-(\d+):\s*\d+ \d+ \d+;/g)].map((m) => m[1]);
    expect(rootDefaults).toEqual(steps);
    for (const step of steps) {
      expect(design.candidatesToCss([`bg-brand-${step}`])[0]).toContain(`--brand-${step}`);
    }
  });
});
