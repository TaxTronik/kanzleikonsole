// =============================================================================
// Code-Splitting-Guard (Review P-25)
//
// Schwere Client-Bibliotheken (Drag-&-Drop-Raster, Datepicker, Tiptap) dürfen
// nur dort statisch importiert werden, wo ihr Inhalt beim ersten Rendern
// sichtbar ist. Standardmäßig geschlossene Dialoge und Bearbeitungsmodi laden
// sie per `next/dynamic` erst beim Öffnen — sonst landen sie im Bundle jeder
// Seite, die nur den Auslöser zeigt (z. B. „Anforderung erstellen" auf vier
// Seiten). Neue statische Importe brauchen hier einen begründeten Eintrag.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve(__dirname, '..', '..');

/** Modul (Paket oder src-relativer Pfad ohne Endung) → erlaubte statische Importeure. */
const STATIC_IMPORT_ALLOWLIST: Record<string, readonly string[]> = {
  // Nur über next/dynamic aus dashboard-grid.tsx; ACP-Layout-Editor zeigt das Raster sofort.
  'react-grid-layout': [
    'app/staff/(protected)/dashboard/dashboard-grid-editor.tsx',
    'app/staff/(protected)/admin/settings/client-layout-form.tsx',
  ],
  'app/staff/(protected)/dashboard/dashboard-grid-editor': [],
  'react-datepicker': ['components/datetime-picker.tsx'],
  // Vollseite „Neue Anforderung" zeigt den Picker sofort; Dialoge laden ihn nach.
  'components/datetime-picker': ['components/requests/new-request-form.tsx'],
  'components/requests/new-request-form': [
    'app/staff/(protected)/clients/[id]/requests/new/page.tsx',
  ],
  // Editor ist jeweils der Seiteninhalt (Wissensartikel, Subsumtion).
  '@tiptap/react': [
    'app/staff/(protected)/knowledge/rich-markdown-editor.tsx',
    'app/staff/(protected)/clients/[id]/subsumtion/editor-toolbar.tsx',
    'app/staff/(protected)/clients/[id]/subsumtion/subsumtion-document.tsx',
  ],
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const toSrcPath = (path: string) => relative(SRC_DIR, path).split(sep).join('/');

/** Statische Laufzeit-Importe einer Datei, normalisiert auf Paketname bzw. src-Pfad. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    const typeOnly =
      clause?.isTypeOnly ||
      (clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly));
    if (typeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith('@/')) result.push(specifier.slice(2));
    else if (specifier.startsWith('.')) result.push(toSrcPath(resolve(dirname(file), specifier)));
    else result.push(specifier);
  }
  return result;
}

describe('schwere Client-Bibliotheken nur bei sichtbarem Inhalt statisch (P-25)', () => {
  const files = sourceFiles(SRC_DIR);
  const importsByFile = new Map(files.map((file) => [toSrcPath(file), staticImports(file)]));

  it.each(Object.entries(STATIC_IMPORT_ALLOWLIST))(
    '%s wird nur von den erlaubten Modulen statisch importiert',
    (module, allowed) => {
      const importers = [...importsByFile]
        .filter(([, imports]) => imports.includes(module))
        .map(([file]) => file)
        .sort();
      expect(importers).toEqual([...allowed].sort());
    },
  );

  it('lädt Dashboard-Editor, Quick-Dialog-Formular und Termin-Picker per next/dynamic', () => {
    const read = (path: string) => readFileSync(join(SRC_DIR, path), 'utf8');
    expect(read('app/staff/(protected)/dashboard/dashboard-grid.tsx')).toMatch(
      /dynamic\(\s*\(\) => import\('\.\/dashboard-grid-editor'\)/,
    );
    expect(read('components/quick-request-dialog.tsx')).toMatch(
      /dynamic\(\s*\(\)\s*=>\s*import\('@\/components\/requests\/new-request-form'\)/,
    );
    expect(read('app/portal/(protected)/appointments/request-form.tsx')).toMatch(
      /dynamic\(\s*\(\) => import\('@\/components\/datetime-picker'\)/,
    );
  });
});
