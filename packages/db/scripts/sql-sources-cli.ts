// =============================================================================
// pnpm db:sql:dump | db:sql:check | db:sql:migration (Review-Finding D-01)
//
//   dump       schreibt die kanonischen SQL-Quellen aus DATABASE_URL nach
//              packages/db/prisma/sql (Objekte, die es nicht mehr gibt, entfallen)
//   check      vergleicht packages/db/prisma/sql mit DATABASE_URL und zeigt
//              Abweichungen als Diff; lehnt Migrationen mit Gerüst-Platzhaltern ab
//   migration  erzeugt aus geänderten Quelldateien ein Migrationsgerüst
//              --name <snake_case> [--rules ID,ID] [--timestamp YYYYMMDDHHMMSS]
//              [--base <git-ref>] [--dry-run] [Dateien …]
//
// Exit 0: in Ordnung; 1: Abweichung oder Bedienfehler; 2: Verbindungs-/SQL-Fehler.
// Ablauf: docs/development/kanonische-sql-quellen.md
// =============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from 'pg';

import {
  RULE_ID_PATTERN,
  SQL_SOURCE_KINDS,
  SQL_SOURCES_DOC,
  compareSqlSources,
  findRuleCandidates,
  findUnfinishedMigrations,
  formatDriftReport,
  hasDrift,
  isSqlSourcePath,
  migrationDirectoryName,
  objectReference,
  readDatabaseSources,
  readRepositorySources,
  renderMigration,
  utcMigrationTimestamp,
  writeSqlSources,
  type CanonicalChange,
  type CatalogRule,
  type SqlSources,
} from './sql-sources';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const SQL_ROOT = join(PACKAGE_ROOT, 'prisma', 'sql');
const MIGRATIONS_ROOT = join(PACKAGE_ROOT, 'prisma', 'migrations');
const CATALOG_FILE = join(REPO_ROOT, 'docs', 'fachkatalog', 'fachkatalog.json');

class UsageError extends Error {}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function repoPath(path: string): string {
  return toPosix(relative(REPO_ROOT, path));
}

async function readDatabase(): Promise<SqlSources> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL nicht gesetzt (frisch migrierte Datenbank nötig).');
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await readDatabaseSources(client);
  } finally {
    await client.end();
  }
}

function countByKind(sources: SqlSources): string {
  return SQL_SOURCE_KINDS.map(
    (kind) => `${[...sources.keys()].filter((path) => path.startsWith(`${kind}/`)).length} ${kind}`,
  ).join(', ');
}

async function dump(root: string): Promise<number> {
  const sources = await readDatabase();
  const summary = writeSqlSources(root, sources);
  console.log(
    `[db:sql:dump] ${sources.size} Dateien (${countByKind(sources)}) in ${repoPath(root)}: ` +
      `${summary.written} geschrieben, ${summary.removed} entfernt, ${summary.unchanged} unverändert.`,
  );
  return 0;
}

async function check(root: string): Promise<number> {
  const database = await readDatabase();
  const repository = readRepositorySources(root);
  const drift = compareSqlSources(database, repository);
  const unfinished = root === SQL_ROOT ? findUnfinishedMigrations(MIGRATIONS_ROOT) : [];
  if (!hasDrift(drift) && unfinished.length === 0) {
    console.log(
      `[db:sql:check] OK: ${database.size} kanonische SQL-Quellen (${countByKind(database)}) ` +
        'stimmen mit der migrierten Datenbank überein.',
    );
    return 0;
  }
  if (hasDrift(drift)) {
    console.error(
      `[db:sql:check] Kanonische SQL-Quellen weichen von der migrierten Datenbank ab.\n\n` +
        `${formatDriftReport(drift, database, repository, repoPath(root))}\n\n` +
        'Behebung: Fehlt die Migration zur geänderten Datei, mit `pnpm db:sql:migration ' +
        '--name <name>` ein Gerüst erzeugen und ausfüllen. Ist die Migration vorhanden, die ' +
        'Datenbank migrieren und `pnpm db:sql:dump` ausführen; die Dateien sind dann der ' +
        `von PostgreSQL normalisierte Stand. Siehe ${SQL_SOURCES_DOC}.`,
    );
  }
  if (unfinished.length > 0) {
    console.error(
      '[db:sql:check] Migrationen enthalten noch Platzhalter aus `pnpm db:sql:migration`:\n' +
        unfinished.map((name) => `  ${name}`).join('\n'),
    );
  }
  return 1;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

function gitShow(base: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${base}:${path}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 << 20,
    });
  } catch {
    return null;
  }
}

/** Pfad relativ zu prisma/sql; nimmt absolute, Repository- und Quellpfade an. */
function sqlRelativePath(argument: string): string {
  const bases = [process.env['INIT_CWD'], process.cwd(), REPO_ROOT, SQL_ROOT].filter(
    (base): base is string => typeof base === 'string' && base.length > 0,
  );
  const candidates = isAbsolute(argument)
    ? [argument]
    : bases.map((base) => resolve(base, argument));
  for (const candidate of candidates) {
    const path = toPosix(relative(SQL_ROOT, candidate));
    if (!path.startsWith('../') && isSqlSourcePath(path)) return path;
  }
  throw new UsageError(`Keine kanonische SQL-Quelldatei unter ${repoPath(SQL_ROOT)}: ${argument}`);
}

function changedPaths(base: string): string[] {
  const scope = repoPath(SQL_ROOT);
  const tracked = git(['diff', '--name-only', '-z', base, '--', scope]);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard', '--', scope]);
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')])]
    .filter(Boolean)
    .map((path) => toPosix(relative(SQL_ROOT, join(REPO_ROOT, path))))
    .filter(isSqlSourcePath);
}

function collectChanges(base: string, files: string[]): CanonicalChange[] {
  const paths = files.length > 0 ? files.map(sqlRelativePath) : changedPaths(base);
  return [...new Set(paths)]
    .map((path) => {
      const file = join(SQL_ROOT, path);
      return {
        path,
        before: gitShow(base, `${repoPath(SQL_ROOT)}/${path}`),
        after: existsSync(file) ? readFileSync(file, 'utf8') : null,
      };
    })
    .filter((change) => change.before !== change.after);
}

function loadCatalog(): CatalogRule[] {
  const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as { rules: CatalogRule[] };
  return catalog.rules;
}

function migrationTexts(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(MIGRATIONS_ROOT, entry.name, 'migration.sql')),
    )
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS_ROOT, entry.name, 'migration.sql'), 'utf8'),
    }));
}

function resolveRuleIds(changes: CanonicalChange[], rules: string | undefined) {
  const catalog = loadCatalog();
  if (rules !== undefined) {
    const ruleIds = rules
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const known = new Set(catalog.map((rule) => rule.id));
    const invalid = ruleIds.filter((id) => !RULE_ID_PATTERN.test(id) || !known.has(id));
    if (invalid.length > 0) {
      throw new UsageError(`Unbekannte Fachkatalog-Regel-IDs: ${invalid.join(', ')}`);
    }
    return { ruleIds, ruleIdSource: undefined };
  }
  const references = changes.map((change) =>
    objectReference(change.path, (change.after ?? change.before)!),
  );
  const candidates = findRuleCandidates(references, migrationTexts(), catalog);
  return {
    ruleIds: candidates.ruleIds,
    ruleIdSource: candidates.sources.length > 0 ? candidates.sources.join(', ') : undefined,
  };
}

interface MigrationArguments {
  name?: string | undefined;
  rules?: string | undefined;
  timestamp?: string | undefined;
  base?: string | undefined;
  'dry-run'?: boolean | undefined;
}

function migration(values: MigrationArguments, files: string[]): number {
  if (!values.name) throw new UsageError('--name <snake_case> fehlt.');
  const changes = collectChanges(values.base ?? 'HEAD', files);
  if (changes.length === 0) {
    throw new UsageError(
      `Keine geänderten Dateien unter ${repoPath(SQL_ROOT)} gegenüber ${values.base ?? 'HEAD'}.`,
    );
  }
  const directory = migrationDirectoryName(
    readdirSync(MIGRATIONS_ROOT),
    values.timestamp ?? utcMigrationTimestamp(new Date()),
    values.name,
  );
  const sql = renderMigration(changes, resolveRuleIds(changes, values.rules));
  if (values['dry-run']) {
    process.stdout.write(sql);
    return 0;
  }
  const target = join(MIGRATIONS_ROOT, directory, 'migration.sql');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, sql, { flag: 'wx' });
  console.log(
    `[db:sql:migration] ${repoPath(target)} aus ${changes.length} Datei(en) erzeugt.\n` +
      'Nächste Schritte: Kopfkommentar ausfüllen und alle Platzhalter entfernen, migrieren, ' +
      '`pnpm db:sql:dump` und `pnpm db:sql:check` ausführen, Migration und Quellen gemeinsam ' +
      `committen (${SQL_SOURCES_DOC}).`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv.filter((argument) => argument !== '--');
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      name: { type: 'string' },
      rules: { type: 'string' },
      timestamp: { type: 'string' },
      base: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const root = values.dir
    ? resolve(process.env['INIT_CWD'] ?? process.cwd(), values.dir)
    : SQL_ROOT;
  if (command === 'dump') return dump(root);
  if (command === 'check') return check(root);
  if (command !== 'migration') throw new UsageError('Befehl fehlt: dump | check | migration');
  // Das Gerüst braucht keine Datenbank: jeder Fehler ist ein Bedien- oder Dateifehler.
  try {
    return migration(values, positionals);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function isUsageError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))
  );
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[db:sql] ${message}`);
    process.exit(isUsageError(error) ? 1 : 2);
  },
);
