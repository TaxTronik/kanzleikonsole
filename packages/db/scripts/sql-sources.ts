// =============================================================================
// Kanonische SQL-Quellen für Funktionen, Trigger und RLS-Policies (Review-Finding D-01)
//
// Je Datenbankobjekt eine Datei unter packages/db/prisma/sql/:
//   functions/<schema>.<name>(<argumenttypen>).sql   pg_get_functiondef
//   triggers/<tabelle>.<trigger>.sql                 pg_get_triggerdef
//   policies/<tabelle>.<policy>.sql                  pg_policies als CREATE POLICY
// (Tabellen außerhalb von public erhalten das Schema als Präfix.) Erfasst werden
// nur die Anwendungsschemas app und public ohne Objekte von Extensions.
//
// Migrationen bleiben der einzige Weg, eine Datenbank zu ändern. Die Dateien sind
// deren lesbarer Endstand je Objekt: `pnpm db:sql:dump` schreibt sie aus einer
// migrierten Datenbank, `pnpm db:sql:check` vergleicht sie mit ihr, und
// `pnpm db:sql:migration` erzeugt aus geänderten Dateien ein Migrationsgerüst.
// Ablauf und Grenzen: docs/development/kanonische-sql-quellen.md.
// =============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SQL_SOURCE_KINDS = ['functions', 'triggers', 'policies'] as const;
export type SqlSourceKind = (typeof SQL_SOURCE_KINDS)[number];

/** Anwendungsschemas; Objekte von pgcrypto, pg_trgm und citext bleiben außen vor. */
export const APPLICATION_SCHEMAS = ['app', 'public'] as const;

export const SQL_SOURCES_DOC = 'docs/development/kanonische-sql-quellen.md';

/** Platzhalter im Migrationsgerüst; `pnpm db:sql:check` lehnt Migrationen damit ab. */
export const MIGRATION_TODO_MARKER = 'TODO(db:sql:migration)';

/** Relativer Pfad (z. B. `functions/app.f(uuid).sql`) → Dateiinhalt. */
export type SqlSources = Map<string, string>;

/** Minimale Abfrage-Schnittstelle (pg.Client, pg.PoolClient). */
export interface SqlQueryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

// -----------------------------------------------------------------------------
// Datenbank lesen
// -----------------------------------------------------------------------------

// Die Deparse-Ausgaben hängen von Sitzungseinstellungen ab: der search_path
// entscheidet, welche Namen qualifiziert erscheinen; DateStyle, IntervalStyle,
// TimeZone und extra_float_digits bestimmen die Darstellung von Konstanten. Mit
// festen Werten (wie pg_dump: leerer search_path) ist die Ausgabe unabhängig von
// Rolle, Datenbank- und Client-Voreinstellungen.
export const SESSION_SETTINGS_SQL = `SELECT
  pg_catalog.set_config('search_path', '', false),
  pg_catalog.set_config('DateStyle', 'ISO, YMD', false),
  pg_catalog.set_config('IntervalStyle', 'postgres', false),
  pg_catalog.set_config('TimeZone', 'UTC', false),
  pg_catalog.set_config('extra_float_digits', '3', false),
  pg_catalog.set_config('quote_all_identifiers', 'off', false),
  pg_catalog.set_config('standard_conforming_strings', 'on', false)`;

const SCHEMA_LIST = APPLICATION_SCHEMAS.map((schema) => `'${schema}'`).join(', ');

function notExtensionMember(catalog: string, objectId: string): string {
  return `NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid = '${catalog}'::pg_catalog.regclass
        AND d.objid = ${objectId}
        AND d.deptype = 'e')`;
}

export const FUNCTIONS_SQL = `
SELECT n.nspname AS schema,
       p.proname AS name,
       p.prokind AS kind,
       ARRAY(
         SELECT CASE WHEN tn.nspname = 'pg_catalog' THEN '' ELSE tn.nspname || '.' END
                || base.typname
                || CASE WHEN t.typcategory = 'A' AND t.typelem <> 0 THEN '[]' ELSE '' END
           FROM unnest(p.proargtypes::pg_catalog.oid[]) WITH ORDINALITY AS a(type_oid, position)
           JOIN pg_catalog.pg_type t ON t.oid = a.type_oid
           JOIN pg_catalog.pg_type base
             ON base.oid = CASE WHEN t.typcategory = 'A' AND t.typelem <> 0
                                THEN t.typelem ELSE t.oid END
           JOIN pg_catalog.pg_namespace tn ON tn.oid = base.typnamespace
          ORDER BY a.position
       )::text[] AS arg_types,
       CASE WHEN p.prokind IN ('f', 'p') THEN pg_catalog.pg_get_functiondef(p.oid) END AS definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN (${SCHEMA_LIST})
   AND ${notExtensionMember('pg_catalog.pg_proc', 'p.oid')}`;

export const TRIGGERS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table_name,
       t.tgname AS name,
       t.tgenabled AS enabled,
       pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS qualified_table,
       pg_catalog.quote_ident(t.tgname) AS quoted_name,
       pg_catalog.pg_get_triggerdef(t.oid, false) AS definition
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal
   AND n.nspname IN (${SCHEMA_LIST})
   AND ${notExtensionMember('pg_catalog.pg_class', 'c.oid')}`;

// pg_policies liefert USING/WITH CHECK über pg_get_expr; "public" steht für PUBLIC.
export const POLICIES_SQL = `
SELECT p.schemaname AS schema,
       p.tablename AS table_name,
       p.policyname AS name,
       pg_catalog.quote_ident(p.schemaname) || '.' || pg_catalog.quote_ident(p.tablename)
         AS qualified_table,
       pg_catalog.quote_ident(p.policyname) AS quoted_name,
       p.permissive,
       ARRAY(
         SELECT CASE WHEN r = 'public' THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r) END
           FROM unnest(p.roles) AS r
       )::text[] AS roles,
       p.cmd AS command,
       p.qual,
       p.with_check
  FROM pg_catalog.pg_policies p
 WHERE p.schemaname IN (${SCHEMA_LIST})`;

export interface FunctionRow {
  schema: string;
  name: string;
  kind: string;
  arg_types: string[];
  definition: string | null;
}

export interface TriggerRow {
  schema: string;
  table_name: string;
  name: string;
  enabled: string;
  qualified_table: string;
  quoted_name: string;
  definition: string;
}

export interface PolicyRow {
  schema: string;
  table_name: string;
  name: string;
  qualified_table: string;
  quoted_name: string;
  permissive: string;
  roles: string[];
  command: string;
  qual: string | null;
  with_check: string | null;
}

export interface CatalogRows {
  functions: FunctionRow[];
  triggers: TriggerRow[];
  policies: PolicyRow[];
}

export async function readCatalogRows(client: SqlQueryable): Promise<CatalogRows> {
  await client.query(SESSION_SETTINGS_SQL);
  const functions = (await client.query(FUNCTIONS_SQL)).rows as FunctionRow[];
  const triggers = (await client.query(TRIGGERS_SQL)).rows as TriggerRow[];
  const policies = (await client.query(POLICIES_SQL)).rows as PolicyRow[];
  return { functions, triggers, policies };
}

export async function readDatabaseSources(client: SqlQueryable): Promise<SqlSources> {
  return buildSqlSources(await readCatalogRows(client));
}

// -----------------------------------------------------------------------------
// Normalisieren und rendern
// -----------------------------------------------------------------------------

/** LF, keine Leerzeichen/Tabs am Zeilenende, genau ein Zeilenumbruch am Dateiende. */
export function normalizeSql(text: string): string {
  const lines = text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** Ein Statement, das mit Semikolon und Zeilenumbruch endet. */
function statement(text: string): string {
  return normalizeSql(`${text.replace(/\s+$/u, '')};`);
}

export function renderFunction(row: FunctionRow): string {
  if (row.definition === null || !['f', 'p'].includes(row.kind)) {
    throw new Error(
      `${row.schema}.${row.name}: Funktionsart "${row.kind}" (Aggregat/Fensterfunktion) wird ` +
        'von den kanonischen SQL-Quellen nicht unterstützt.',
    );
  }
  return statement(row.definition);
}

const TRIGGER_STATE_STATEMENTS: Record<string, string | null> = {
  O: null,
  D: 'DISABLE TRIGGER',
  A: 'ENABLE ALWAYS TRIGGER',
  R: 'ENABLE REPLICA TRIGGER',
};

export function renderTrigger(row: TriggerRow): string {
  const toggle = TRIGGER_STATE_STATEMENTS[row.enabled];
  if (toggle === undefined) {
    throw new Error(`${row.table_name}.${row.name}: unbekannter Triggerzustand "${row.enabled}".`);
  }
  const statements = [`${row.definition};`];
  if (toggle) statements.push(`ALTER TABLE ${row.qualified_table} ${toggle} ${row.quoted_name};`);
  return normalizeSql(statements.join('\n'));
}

const POLICY_COMMANDS = new Set(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);

export function renderPolicy(row: PolicyRow): string {
  if (
    !['PERMISSIVE', 'RESTRICTIVE'].includes(row.permissive) ||
    !POLICY_COMMANDS.has(row.command)
  ) {
    throw new Error(`${row.table_name}.${row.name}: unerwartete Policy-Art.`);
  }
  // PUBLIC und Rollen in fester Reihenfolge (Codepunkte statt Sortierregel der DB).
  const roles = [...row.roles].sort();
  const lines = [
    `CREATE POLICY ${row.quoted_name} ON ${row.qualified_table}`,
    `  AS ${row.permissive}`,
    `  FOR ${row.command}`,
    `  TO ${roles.join(', ')}`,
  ];
  if (row.qual !== null) lines.push(`  USING (${row.qual})`);
  if (row.with_check !== null) lines.push(`  WITH CHECK (${row.with_check})`);
  return statement(lines.join('\n'));
}

// Dateinamen bleiben auf allen Plattformen gültig (keine Anführungszeichen,
// Leerzeichen oder Pfadtrenner); Kollisionen werden unten abgewiesen.
function fileNamePart(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9_$]/gu, '_');
}

function fileNameType(typeLabel: string): string {
  return typeLabel.replace(/[^A-Za-z0-9_$.[\]]/gu, '_');
}

export function functionSourcePath(
  row: Pick<FunctionRow, 'schema' | 'name' | 'arg_types'>,
): string {
  const args = row.arg_types.map(fileNameType).join(',');
  return `functions/${fileNamePart(row.schema)}.${fileNamePart(row.name)}(${args}).sql`;
}

export function tableObjectSourcePath(
  kind: 'triggers' | 'policies',
  schema: string,
  table: string,
  name: string,
): string {
  const prefix = schema === 'public' ? '' : `${fileNamePart(schema)}.`;
  return `${kind}/${prefix}${fileNamePart(table)}.${fileNamePart(name)}.sql`;
}

/** Codepunkt-Reihenfolge, unabhängig von Locale und Plattform. */
export function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function sortedSources(entries: Iterable<[string, string]>): SqlSources {
  return new Map([...entries].sort(([left], [right]) => compareCodePoints(left, right)));
}

function addSource(
  target: Map<string, string>,
  folded: Map<string, string>,
  path: string,
  content: string,
) {
  if (target.has(path)) throw new Error(`Doppelter Quellpfad: ${path}`);
  // Windows und macOS unterscheiden Groß-/Kleinschreibung im Dateinamen nicht.
  const key = path.toLowerCase();
  const existing = folded.get(key);
  if (existing !== undefined) {
    throw new Error(`Quellpfade unterscheiden sich nur in der Schreibweise: ${existing}, ${path}`);
  }
  target.set(path, content);
  folded.set(key, path);
}

export function buildSqlSources(rows: CatalogRows): SqlSources {
  const sources = new Map<string, string>();
  const folded = new Map<string, string>();
  for (const row of rows.functions) {
    addSource(sources, folded, functionSourcePath(row), renderFunction(row));
  }
  for (const row of rows.triggers) {
    const path = tableObjectSourcePath('triggers', row.schema, row.table_name, row.name);
    addSource(sources, folded, path, renderTrigger(row));
  }
  for (const row of rows.policies) {
    const path = tableObjectSourcePath('policies', row.schema, row.table_name, row.name);
    addSource(sources, folded, path, renderPolicy(row));
  }
  return sortedSources(sources);
}

// -----------------------------------------------------------------------------
// Repository lesen und schreiben
// -----------------------------------------------------------------------------

export function isSqlSourcePath(path: string): boolean {
  const [kind, file, ...rest] = path.split('/');
  return (
    rest.length === 0 &&
    SQL_SOURCE_KINDS.includes(kind as SqlSourceKind) &&
    typeof file === 'string' &&
    file.endsWith('.sql')
  );
}

/** Rohinhalte der *.sql-Dateien in functions/, triggers/ und policies/. */
export function readRepositorySources(root: string): SqlSources {
  const sources: Array<[string, string]> = [];
  for (const kind of SQL_SOURCE_KINDS) {
    const directory = join(root, kind);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
      sources.push([`${kind}/${entry.name}`, readFileSync(join(directory, entry.name), 'utf8')]);
    }
  }
  return sortedSources(sources);
}

export interface WriteSummary {
  written: number;
  removed: number;
  unchanged: number;
}

/** Schreibt den Stand und entfernt *.sql-Dateien von Objekten, die es nicht mehr gibt. */
export function writeSqlSources(root: string, sources: SqlSources): WriteSummary {
  const existing = readRepositorySources(root);
  const summary: WriteSummary = { written: 0, removed: 0, unchanged: 0 };
  for (const kind of SQL_SOURCE_KINDS) mkdirSync(join(root, kind), { recursive: true });
  for (const path of existing.keys()) {
    if (sources.has(path)) continue;
    rmSync(join(root, path));
    summary.removed++;
  }
  for (const [path, content] of sources) {
    if (existing.get(path) === content) {
      summary.unchanged++;
      continue;
    }
    writeFileSync(join(root, path), content);
    summary.written++;
  }
  return summary;
}

// -----------------------------------------------------------------------------
// Vergleich und lesbarer Bericht
// -----------------------------------------------------------------------------

export interface SqlSourceDrift {
  /** In beiden vorhanden, Inhalt verschieden. */
  changed: string[];
  /** Nur in der Datenbank: die Datei fehlt im Repository. */
  missing: string[];
  /** Nur im Repository: das Objekt fehlt in der Datenbank. */
  unexpected: string[];
  /** Datei nicht normalisiert (CRLF, Leerraum am Zeilenende, Dateiende). */
  unnormalized: string[];
}

export function compareSqlSources(database: SqlSources, repository: SqlSources): SqlSourceDrift {
  const drift: SqlSourceDrift = { changed: [], missing: [], unexpected: [], unnormalized: [] };
  for (const [path, expected] of database) {
    const actual = repository.get(path);
    if (actual === undefined) drift.missing.push(path);
    else if (normalizeSql(actual) !== expected) drift.changed.push(path);
  }
  for (const [path, actual] of repository) {
    if (!database.has(path)) drift.unexpected.push(path);
    if (normalizeSql(actual) !== actual) drift.unnormalized.push(path);
  }
  return drift;
}

export function hasDrift(drift: SqlSourceDrift): boolean {
  return Object.values(drift).some((paths) => paths.length > 0);
}

type DiffOp = { kind: ' ' | '-' | '+'; line: string };

const LCS_CELL_LIMIT = 4_000_000;

function lcsOps(before: string[], after: string[]): DiffOp[] {
  const rows = before.length;
  const columns = after.length;
  if (rows * columns > LCS_CELL_LIMIT) {
    return [
      ...before.map((line): DiffOp => ({ kind: '-', line })),
      ...after.map((line): DiffOp => ({ kind: '+', line })),
    ];
  }
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && before[i] === after[j]) {
      ops.push({ kind: ' ', line: before[i++]! });
      j++;
    } else if (
      j >= columns ||
      (i < rows && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
    ) {
      ops.push({ kind: '-', line: before[i++]! });
    } else {
      ops.push({ kind: '+', line: after[j++]! });
    }
  }
  return ops;
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const same = (line: string): DiffOp => ({ kind: ' ', line });
  return [
    ...before.slice(0, start).map(same),
    ...lcsOps(before.slice(start, endBefore), after.slice(start, endAfter)),
    ...before.slice(endBefore).map(same),
  ];
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function hunkRanges(ops: DiffOp[], context: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  ops.forEach((op, index) => {
    if (op.kind === ' ') return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  });
  return ranges;
}

function hunkHeader(ops: DiffOp[], from: number, to: number): string {
  let oldStart = 1;
  let newStart = 1;
  for (const op of ops.slice(0, from)) {
    if (op.kind !== '+') oldStart++;
    if (op.kind !== '-') newStart++;
  }
  const hunk = ops.slice(from, to);
  const oldCount = hunk.filter((op) => op.kind !== '+').length;
  const newCount = hunk.filter((op) => op.kind !== '-').length;
  const oldPart = oldCount === 0 ? `${oldStart - 1},0` : `${oldStart},${oldCount}`;
  const newPart = newCount === 0 ? `${newStart - 1},0` : `${newStart},${newCount}`;
  return `@@ -${oldPart} +${newPart} @@`;
}

/** Unified Diff mit `context` Zeilen Kontext; leer, wenn beide Texte gleich sind. */
export function unifiedDiff(
  before: string,
  after: string,
  labels: { before: string; after: string },
  context = 3,
): string {
  if (before === after) return '';
  const ops = diffOps(splitLines(before), splitLines(after));
  const lines = [`--- ${labels.before}`, `+++ ${labels.after}`];
  for (const [from, to] of hunkRanges(ops, context)) {
    lines.push(hunkHeader(ops, from, to));
    for (const op of ops.slice(from, to)) lines.push(`${op.kind}${op.line}`);
  }
  return `${lines.join('\n')}\n`;
}

function pathList(title: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  return ['', `${title} (${paths.length}):`, ...paths.map((path) => `  ${path}`)];
}

export function formatDriftReport(
  drift: SqlSourceDrift,
  database: SqlSources,
  repository: SqlSources,
  displayRoot = 'packages/db/prisma/sql',
): string {
  const lines: string[] = [];
  if (drift.changed.length > 0) {
    lines.push('', `Abweichender Inhalt (${drift.changed.length}), "-" Repository, "+" Datenbank:`);
    for (const path of drift.changed) {
      lines.push(
        unifiedDiff(normalizeSql(repository.get(path) ?? ''), database.get(path) ?? '', {
          before: `${displayRoot}/${path} (Repository)`,
          after: `${displayRoot}/${path} (Datenbank)`,
        }).trimEnd(),
      );
    }
  }
  lines.push(
    ...pathList('Nur in der Datenbank, Datei fehlt im Repository', drift.missing),
    ...pathList('Nur im Repository, Objekt fehlt in der Datenbank', drift.unexpected),
    ...pathList(
      'Nicht normalisiert (CRLF, Leerraum am Zeilenende oder Dateiende)',
      drift.unnormalized,
    ),
  );
  return lines.join('\n').replace(/^\n/u, '');
}

/** Migrationen, deren Gerüst noch Platzhalter von `pnpm db:sql:migration` enthält. */
export function findUnfinishedMigrations(migrationsRoot: string): string[] {
  if (!existsSync(migrationsRoot)) return [];
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const file = join(migrationsRoot, name, 'migration.sql');
      return existsSync(file) && readFileSync(file, 'utf8').includes(MIGRATION_TODO_MARKER);
    })
    .sort(compareCodePoints);
}

// -----------------------------------------------------------------------------
// Migrationsgerüst aus geänderten Quelldateien
// -----------------------------------------------------------------------------

type Token = { kind: 'quoted' | 'string' | 'word' | 'punct'; text: string };

// Tokens außerhalb von Literalen: "Bezeichner", 'Text', Wörter und Satzzeichen.
// Reicht für die von pg_get_functiondef/pg_get_triggerdef erzeugten Kopfzeilen.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z0-9_$]+|\S/gu;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    let kind: Token['kind'] = 'punct';
    if (value.startsWith('"')) kind = 'quoted';
    else if (value.startsWith("'")) kind = 'string';
    else if (/^[A-Za-z0-9_$]/u.test(value)) kind = 'word';
    tokens.push({ kind, text: value });
  }
  return tokens;
}

function isIdentifier(token: Token | undefined): token is Token {
  return token !== undefined && (token.kind === 'word' || token.kind === 'quoted');
}

/** Liest `ident[.ident]` ab `start`; liefert Text und Index nach dem Namen. */
function readQualifiedName(tokens: Token[], start: number): { text: string; next: number } {
  const first = tokens[start];
  if (!isIdentifier(first)) throw new Error('Objektname erwartet.');
  let text = first.text;
  let next = start + 1;
  while (tokens[next]?.text === '.' && isIdentifier(tokens[next + 1])) {
    text += `.${tokens[next + 1]!.text}`;
    next += 2;
  }
  return { text, next };
}

function wordIndex(tokens: Token[], word: string, from = 0): number {
  return tokens.findIndex(
    (token, index) => index >= from && token.kind === 'word' && token.text.toUpperCase() === word,
  );
}

/** Teilt an `separator` außerhalb von Klammern und Literalen. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth++;
    } else if (char === ')' || char === ']') {
      depth--;
    } else if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** Entfernt `DEFAULT …`/`= …` eines Arguments (DROP FUNCTION kennt keine Defaults). */
export function stripArgumentDefault(argument: string): string {
  const tokens = argument.split(/\s+/u);
  const cut = tokens.findIndex((token) => token.toUpperCase() === 'DEFAULT' || token === '=');
  return (cut === -1 ? tokens : tokens.slice(0, cut)).join(' ');
}

function balancedParentheses(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && --depth === 0) {
      return index;
    }
  }
  throw new Error('Argumentliste ohne schließende Klammer.');
}

export interface FunctionSignature {
  /** FUNCTION oder PROCEDURE */
  objectType: 'FUNCTION' | 'PROCEDURE';
  qualifiedName: string;
  /** Argumentliste ohne Defaults, geeignet für DROP FUNCTION. */
  identityArguments: string;
}

export function parseFunctionSignature(definition: string): FunctionSignature {
  const header = definition.match(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+/iu);
  if (!header) throw new Error('Funktionsdatei beginnt nicht mit CREATE [OR REPLACE] FUNCTION.');
  const rest = definition.slice(header[0].length);
  const open = rest.indexOf('(');
  if (open === -1) throw new Error('Funktionsdatei ohne Argumentliste.');
  const nameTokens = tokenize(rest.slice(0, open));
  const { text: qualifiedName, next } = readQualifiedName(nameTokens, 0);
  if (next !== nameTokens.length) throw new Error('Unerwartete Zeichen im Funktionsnamen.');
  const close = balancedParentheses(rest, open);
  const identityArguments = splitTopLevel(rest.slice(open + 1, close))
    .map(stripArgumentDefault)
    .join(', ');
  return {
    objectType: header[1]!.toUpperCase() as FunctionSignature['objectType'],
    qualifiedName,
    identityArguments,
  };
}

export interface TableObjectTarget {
  quotedName: string;
  qualifiedTable: string;
}

/** Name und Tabelle aus `CREATE [CONSTRAINT] TRIGGER name … ON tabelle …`. */
export function parseTriggerTarget(definition: string): TableObjectTarget {
  const tokens = tokenize(definition.split(';')[0] ?? '');
  const trigger = wordIndex(tokens, 'TRIGGER');
  if (wordIndex(tokens, 'CREATE') !== 0 || trigger === -1 || !isIdentifier(tokens[trigger + 1])) {
    throw new Error('Triggerdatei beginnt nicht mit CREATE [CONSTRAINT] TRIGGER <name>.');
  }
  // pg_get_triggerdef setzt Spaltennamen wie "on" in Anführungszeichen; das erste
  // unquotierte ON leitet deshalb immer die Tabelle ein.
  const on = wordIndex(tokens, 'ON', trigger + 2);
  if (on === -1) throw new Error('Triggerdatei ohne ON <tabelle>.');
  return {
    quotedName: tokens[trigger + 1]!.text,
    qualifiedTable: readQualifiedName(tokens, on + 1).text,
  };
}

/** Name und Tabelle aus `CREATE POLICY name ON tabelle`. */
export function parsePolicyTarget(definition: string): TableObjectTarget {
  const tokens = tokenize(definition.split('\n')[0] ?? '');
  if (
    wordIndex(tokens, 'CREATE') !== 0 ||
    wordIndex(tokens, 'POLICY') !== 1 ||
    !isIdentifier(tokens[2]) ||
    wordIndex(tokens, 'ON') !== 3
  ) {
    throw new Error('Policydatei beginnt nicht mit CREATE POLICY <name> ON <tabelle>.');
  }
  return { quotedName: tokens[2]!.text, qualifiedTable: readQualifiedName(tokens, 4).text };
}

export function unquoteIdentifier(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier;
}

export interface CanonicalChange {
  /** Relativ zu prisma/sql, z. B. `triggers/client.client_audit.sql`. */
  path: string;
  /** Inhalt im Vergleichsstand (null: neu). */
  before: string | null;
  /** Inhalt im Arbeitsstand (null: gelöscht). */
  after: string | null;
}

export function sourceKind(path: string): SqlSourceKind {
  const kind = path.split('/')[0] as SqlSourceKind;
  if (!isSqlSourcePath(path)) throw new Error(`Keine kanonische SQL-Quelldatei: ${path}`);
  return kind;
}

function dropFunctionStatement(definition: string): string {
  const signature = parseFunctionSignature(definition);
  return `DROP ${signature.objectType} ${signature.qualifiedName}(${signature.identityArguments});`;
}

function dropTableObjectStatement(kind: 'triggers' | 'policies', definition: string): string {
  const target =
    kind === 'triggers' ? parseTriggerTarget(definition) : parsePolicyTarget(definition);
  const objectType = kind === 'triggers' ? 'TRIGGER' : 'POLICY';
  return `DROP ${objectType} ${target.quotedName} ON ${target.qualifiedTable};`;
}

function headerLine(definition: string, pattern: RegExp): string | undefined {
  return definition.split('\n').find((line) => pattern.test(line));
}

function functionChangeWarnings(change: CanonicalChange): string[] {
  if (change.before === null || change.after === null) return [];
  const before = parseFunctionSignature(change.before);
  const after = parseFunctionSignature(change.after);
  const warnings: string[] = [];
  if (
    before.qualifiedName !== after.qualifiedName ||
    before.identityArguments !== after.identityArguments
  ) {
    warnings.push(
      `-- ${MIGRATION_TODO_MARKER}: Signatur von ${before.qualifiedName} geändert; die alte ` +
        'Fassung wird am Ende entfernt. Abhängige Trigger/Policies prüfen.',
    );
  }
  const returns = /^\s*RETURNS\s/iu;
  if (headerLine(change.before, returns) !== headerLine(change.after, returns)) {
    warnings.push(
      `-- ${MIGRATION_TODO_MARKER}: Rückgabetyp von ${after.qualifiedName} geändert; ` +
        'CREATE OR REPLACE ändert ihn nicht. DROP und abhängige Objekte prüfen.',
    );
  }
  return warnings;
}

function signatureChanged(change: CanonicalChange): boolean {
  if (change.before === null || change.after === null) return false;
  return dropFunctionStatement(change.before) !== dropFunctionStatement(change.after);
}

interface MigrationStatements {
  drops: string[];
  functions: string[];
  triggers: string[];
  policies: string[];
  functionDrops: string[];
}

function collectStatements(changes: CanonicalChange[]): MigrationStatements {
  const result: MigrationStatements = {
    drops: [],
    functions: [],
    triggers: [],
    policies: [],
    functionDrops: [],
  };
  for (const change of [...changes].sort((a, b) => compareCodePoints(a.path, b.path))) {
    const kind = sourceKind(change.path);
    if (kind === 'functions') {
      if (change.after !== null) {
        result.functions.push(
          [...functionChangeWarnings(change), normalizeSql(change.after).trimEnd()].join('\n'),
        );
      }
      if (change.before !== null && (change.after === null || signatureChanged(change))) {
        result.functionDrops.push(dropFunctionStatement(change.before));
      }
      continue;
    }
    if (change.before !== null) result.drops.push(dropTableObjectStatement(kind, change.before));
    if (change.after !== null) result[kind].push(normalizeSql(change.after).trimEnd());
  }
  return result;
}

function changeLabel(change: CanonicalChange): string {
  if (change.before === null) return 'neu:      ';
  if (change.after === null) return 'entfernt: ';
  return 'geändert: ';
}

export interface MigrationOptions {
  /** Regel-IDs für die Kopfzeile. */
  ruleIds: string[];
  /** Herkunft, wenn die IDs nicht ausdrücklich übergeben, sondern abgeleitet wurden. */
  ruleIdSource?: string | undefined;
}

function migrationHeader(changes: CanonicalChange[], options: MigrationOptions): string[] {
  const header: string[] = [];
  if (options.ruleIds.length === 0) {
    header.push(`-- ${MIGRATION_TODO_MARKER}: Fachkatalog-Regel-IDs nennen.`);
  } else {
    header.push(`-- ${options.ruleIds.join(' / ')}.`);
    if (options.ruleIdSource) {
      header.push(
        `-- ${MIGRATION_TODO_MARKER}: Regel-IDs prüfen (abgeleitet aus ${options.ruleIdSource}).`,
      );
    }
  }
  header.push(
    '--',
    `-- ${MIGRATION_TODO_MARKER}: Anlass, Änderung und Verhalten beschreiben.`,
    '--',
    '-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql',
    `-- (${SQL_SOURCES_DOC}):`,
    ...[...changes]
      .sort((a, b) => compareCodePoints(a.path, b.path))
      .map((change) => `--   ${changeLabel(change)}${change.path}`),
  );
  return header;
}

/**
 * Migrationsgerüst im Stil des Repositorys: Kopfkommentar mit Regel-IDs,
 * BEGIN/COMMIT, LF. Reihenfolge: alte Trigger/Policies entfernen, Funktionen
 * anlegen/ersetzen, Trigger und Policies anlegen, entfallene Funktionen entfernen.
 */
export function renderMigration(changes: CanonicalChange[], options: MigrationOptions): string {
  const relevant = changes.filter((change) => change.before !== change.after);
  if (relevant.length === 0) throw new Error('Keine geänderten kanonischen SQL-Quellen.');
  const statements = collectStatements(relevant);
  const body = [
    ...statements.drops,
    ...statements.functions,
    ...statements.triggers,
    ...statements.policies,
    ...statements.functionDrops,
  ];
  return normalizeSql(
    [...migrationHeader(relevant, options), 'BEGIN;', '', body.join('\n\n'), '', 'COMMIT;'].join(
      '\n',
    ),
  );
}

// -----------------------------------------------------------------------------
// Regel-IDs aus den Migrationen, die ein Objekt zuletzt definiert haben
// -----------------------------------------------------------------------------

export const RULE_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d{3}$/u;

export interface CatalogRule {
  id: string;
  code_refs?: string[];
}

export interface MigrationText {
  name: string;
  sql: string;
}

export interface ObjectReference {
  kind: SqlSourceKind;
  /** Funktion: `schema.name`; Trigger/Policy: Objektname. */
  name: string;
  /** Trigger/Policy: Tabelle ohne Schema. */
  table?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function quotedOrBare(identifier: string): string {
  return `"?${escapeRegExp(identifier)}"?`;
}

function definitionPattern(reference: ObjectReference): RegExp {
  if (reference.kind === 'functions') {
    const [schema, name] = reference.name.split('.') as [string, string];
    const schemaPart =
      schema === 'public' ? `(?:${quotedOrBare(schema)}\\.)?` : `${quotedOrBare(schema)}\\.`;
    return new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+${schemaPart}${quotedOrBare(name)}\\s*\\(`,
      'iu',
    );
  }
  // Tabelle ohne oder mit Schema public; danach Leerraum, Semikolon oder Zeilenende.
  const table = `(?:"?public"?\\.)?${quotedOrBare(reference.table ?? '')}(?=[\\s;(]|$)`;
  if (reference.kind === 'triggers') {
    // [^;]*? hält die Suche nach ON <tabelle> innerhalb desselben Statements.
    return new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${quotedOrBare(reference.name)}\\s[^;]*?\\sON\\s+${table}`,
      'iu',
    );
  }
  return new RegExp(
    `(?:CREATE|ALTER)\\s+POLICY\\s+${quotedOrBare(reference.name)}\\s+ON\\s+${table}`,
    'iu',
  );
}

function headerRuleIds(sql: string, known: Set<string>): string[] {
  const header: string[] = [];
  for (const line of sql.split('\n')) {
    if (line.startsWith('--') || line.trim() === '') header.push(line);
    else break;
  }
  const ids = header.join('\n').match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d{3}\b/gu) ?? [];
  return ids.filter((id) => known.has(id));
}

export interface RuleCandidates {
  ruleIds: string[];
  /** Migrationen, aus denen die IDs stammen. */
  sources: string[];
}

/**
 * Regel-IDs aus der jüngsten Migration je Objekt, die es definiert und Regel-IDs
 * trägt (Kopfkommentar oder code_refs des Fachkatalogs). Nur ein Vorschlag:
 * der Entwickler bestätigt die IDs im Gerüst.
 */
export function findRuleCandidates(
  references: ObjectReference[],
  migrations: MigrationText[],
  catalog: CatalogRule[],
): RuleCandidates {
  const known = new Set(catalog.map((rule) => rule.id));
  const newestFirst = [...migrations].sort((a, b) => compareCodePoints(b.name, a.name));
  const ruleIds = new Set<string>();
  const sources = new Set<string>();
  for (const reference of references) {
    const pattern = definitionPattern(reference);
    for (const migration of newestFirst) {
      if (!pattern.test(migration.sql)) continue;
      const refPath = `packages/db/prisma/migrations/${migration.name}/migration.sql`;
      const ids = [
        ...headerRuleIds(migration.sql, known),
        ...catalog.filter((rule) => rule.code_refs?.includes(refPath)).map((rule) => rule.id),
      ];
      if (ids.length === 0) continue;
      ids.forEach((id) => ruleIds.add(id));
      sources.add(migration.name);
      break;
    }
  }
  return {
    ruleIds: [...ruleIds].sort(compareCodePoints),
    sources: [...sources].sort(compareCodePoints),
  };
}

export function objectReference(path: string, definition: string): ObjectReference {
  const kind = sourceKind(path);
  if (kind === 'functions') {
    const parts = parseFunctionSignature(definition).qualifiedName.split('.');
    return { kind, name: parts.map(unquoteIdentifier).join('.') };
  }
  const target =
    kind === 'triggers' ? parseTriggerTarget(definition) : parsePolicyTarget(definition);
  const table = target.qualifiedTable.split('.').map(unquoteIdentifier).pop() ?? '';
  return { kind, name: unquoteIdentifier(target.quotedName), table };
}

// -----------------------------------------------------------------------------
// Migrationsverzeichnis
// -----------------------------------------------------------------------------

export const MIGRATION_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;
export const MIGRATION_TIMESTAMP_PATTERN = /^\d{14}$/u;

export function utcMigrationTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:T]/gu, '').slice(0, 14);
}

/** Prüft Name und Zeitstempel; der Zeitstempel muss hinter der jüngsten Migration liegen. */
export function migrationDirectoryName(
  existing: string[],
  timestamp: string,
  name: string,
): string {
  if (!MIGRATION_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error(`Zeitstempel muss YYYYMMDDHHMMSS sein: ${timestamp}`);
  }
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new Error(`Migrationsname muss snake_case sein: ${name}`);
  }
  const latest = existing
    .map((directory) => directory.slice(0, 14))
    .filter((prefix) => MIGRATION_TIMESTAMP_PATTERN.test(prefix))
    .sort(compareCodePoints)
    .pop();
  if (latest !== undefined && compareCodePoints(timestamp, latest) <= 0) {
    throw new Error(
      `Zeitstempel ${timestamp} liegt nicht hinter der jüngsten Migration (${latest}).`,
    );
  }
  return `${timestamp}_${name}`;
}
