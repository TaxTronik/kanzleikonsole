#!/usr/bin/env node

// Prueft die versionierten DB-Invarianten (packages/db/invariants/**/*.sql)
// gegen DATABASE_URL. Dieselben Dateien fuehrt scripts/ops-lib.sh nach jeder
// Kundenmigration per psql im Postgres-Container aus und startet bei einer
// Verletzung keine schreibenden Dienste. CI ruft diesen Pruefer im db- und im
// upgrade-path-Job gegen die echte, migrierte Datenbank auf.
//
// Vertrag je Datei: genau ein lesendes Statement mit der Ergebnisspalte
// "invariant"; eine Zeile je verletzter Invariante mit stabilem, nicht leerem
// Namen; keine Zeile = alle Invarianten der Datei erfuellt.
//
// Exit 0 = alle Invarianten erfuellt, 1 = mindestens eine verletzt (Namen auf
// stderr), 2 = SQL-, Verbindungs-, Datei- oder Formatfehler (auch wenn andere
// Dateien zusaetzlich Verletzungen melden). Ein Fehler beweist nichts ueber den
// Schutz und gilt deshalb nie als erfuellt.
//
// Aufruf: node scripts/check-db-invariants.mjs [<datei.sql|verzeichnis> ...]
// Ohne Argument werden alle *.sql unter packages/db/invariants geprueft.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const scriptFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptFile), '..');
const defaultTarget = join(packageRoot, 'invariants');
const tag = '[check:db-invariants]';

export const EXIT_HOLDS = 0;
export const EXIT_VIOLATED = 1;
export const EXIT_ERROR = 2;

function sqlFilesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sqlFilesBelow(path);
    return entry.isFile() && entry.name.endsWith('.sql') ? [path] : [];
  });
}

export function collectInvariantFiles(targets = [defaultTarget]) {
  const files = targets.flatMap((target) => {
    const path = resolve(target);
    return statSync(path).isDirectory() ? sqlFilesBelow(path) : [path];
  });
  return [...new Set(files)].sort();
}

export class InvariantFormatError extends Error {
  name = 'InvariantFormatError';
}

// Wertet das Ergebnis einer Invariantendatei aus und lehnt alles ab, was nicht
// eindeutig dem Vertrag entspricht. Ein fehlerhaftes Format ist ein Fehler,
// nie ein "erfuellt".
export function violationsFromResult(result) {
  if (Array.isArray(result)) {
    throw new InvariantFormatError('Invariantendatei muss genau ein Statement enthalten.');
  }
  const columns = (result.fields ?? []).map((field) => field.name);
  if (columns.length !== 1 || columns[0] !== 'invariant') {
    throw new InvariantFormatError(
      `Ergebnis muss genau die Spalte "invariant" liefern (geliefert: ${columns.join(', ') || 'keine'}).`,
    );
  }
  return result.rows.map((row) => {
    const name = row.invariant;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new InvariantFormatError('Verletzte Invariante ohne Namen geliefert.');
    }
    return name;
  });
}

function fileLabel(file) {
  const label = relative(packageRoot, file);
  return label.startsWith('..') || isAbsolute(label) ? file : label;
}

// Jede Datei laeuft in einer eigenen read-only Transaktion, die immer
// zurueckgerollt wird. Das erweiterte Protokoll laesst serverseitig nur ein
// einziges Statement zu; ein COMMIT kann die Read-only-Grenze nicht verlassen.
async function violationsOf(client, sql) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  let result;
  try {
    result = await client.query({ text: sql, queryMode: 'extended' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  await client.query('ROLLBACK');
  return violationsFromResult(result);
}

function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  // Verbindungsfehler gegen mehrere Adressen (localhost: ::1 und 127.0.0.1)
  // kommen als AggregateError mit leerer Meldung.
  const nested = Array.isArray(error.errors) ? error.errors.map(describeError).join('; ') : '';
  const code = 'code' in error && error.code ? ` [${error.code}]` : '';
  return `${error.message || nested || error.name}${code}`;
}

export async function checkDatabaseInvariants({ connectionString, files, log = console }) {
  if (!connectionString) {
    log.error(`${tag} DATABASE_URL fehlt.`);
    return EXIT_ERROR;
  }
  if (files.length === 0) {
    log.error(`${tag} Keine Invariantendateien gefunden; ohne Pruefung gilt nichts als erfuellt.`);
    return EXIT_ERROR;
  }

  let failed = false;
  let violated = false;
  const client = new Client({ connectionString });
  // Ein Verbindungsabbruch zwischen zwei Abfragen kommt als 'error'-Event.
  // Unbehandelt beendete er den Prozess mit Exit 1, also wie "verletzt".
  client.on('error', (error) => {
    failed = true;
    log.error(`${tag} SQL-/Verbindungsfehler: ${describeError(error)}`);
  });
  try {
    await client.connect();
  } catch (error) {
    log.error(`${tag} SQL-/Verbindungsfehler beim Verbinden: ${describeError(error)}`);
    await client.end().catch(() => undefined);
    return EXIT_ERROR;
  }

  try {
    for (const file of files) {
      const label = fileLabel(file);
      let sql;
      try {
        sql = readFileSync(file, 'utf8');
      } catch (error) {
        failed = true;
        log.error(`${tag} Dateifehler in ${label}: ${describeError(error)}`);
        continue;
      }
      try {
        const violations = await violationsOf(client, sql);
        if (violations.length === 0) {
          log.log(`${tag} OK ${label}`);
          continue;
        }
        violated = true;
        log.error(`${tag} Invariante verletzt (${label}):`);
        for (const name of violations) log.error(`  - ${name}`);
      } catch (error) {
        failed = true;
        const kind =
          error instanceof InvariantFormatError ? 'Formatfehler' : 'SQL-/Verbindungsfehler';
        log.error(`${tag} ${kind} in ${label}: ${describeError(error)}`);
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  if (failed) {
    log.error(
      `${tag} Pruefung unvollstaendig, keine Aussage ueber den Schutz (Exit ${EXIT_ERROR}).`,
    );
    return EXIT_ERROR;
  }
  if (violated) {
    log.error(`${tag} Mindestens eine Invariante ist verletzt (Exit ${EXIT_VIOLATED}).`);
    return EXIT_VIOLATED;
  }
  log.log(`${tag} Alle Invarianten erfuellt (${files.length} Dateien).`);
  return EXIT_HOLDS;
}

export async function main(args = process.argv.slice(2)) {
  let files;
  try {
    files = collectInvariantFiles(args.length > 0 ? args : undefined);
  } catch (error) {
    console.error(`${tag} Invariantendateien nicht lesbar: ${describeError(error)}`);
    return EXIT_ERROR;
  }
  return checkDatabaseInvariants({ connectionString: process.env.DATABASE_URL, files });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  // Node beendet unbehandelte Ausnahmen sonst mit Exit 1 (= "verletzt").
  process.on('uncaughtException', (error) => {
    console.error(`${tag} FATAL: ${describeError(error)}`);
    process.exit(EXIT_ERROR);
  });
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`${tag} FATAL: ${describeError(error)}`);
      process.exitCode = EXIT_ERROR;
    },
  );
}
