#!/usr/bin/env node
// =============================================================================
// .env-Hilfe fuer Setup- und Startskripte (scripts/setup.sh, scripts/setup.ps1,
// scripts/win/Start-TaxTronik.ps1, scripts/win/Start-SignalDev.ps1) und die
// Schwach-Secret-Pruefung der Betriebs-CLI (scripts/ops-lib.sh).
//
// Bewusst ohne npm-Abhaengigkeiten: laeuft vor `pnpm install`. Die Liste
// bekannter Dev-/CI-Defaults kommt aus packages/config/src/dev-default-secrets.json
// (dieselbe Quelle wie das Prod-Gate in @taxtronik/config).
//
//   get    <datei> <KEY>                   Wert der ersten Zeile KEY=... (ohne ")
//   set    <datei> <KEY>                   Wert aus ENV_TOOL_VALUE woertlich setzen
//   unset  <datei> <KEY>                   alle Zeilen KEY=... entfernen
//   secret <bytes>                         Zufallswert, base64url ohne Padding
//   weak   <datei> <KEY>                   weak (leer oder bekannter Default) | ok
//   ensure <datei> <KEY> <bytes> [--replace-weak]
//          leeren (oder mit --replace-weak schwachen) Wert durch ein Secret
//          ersetzen; Ausgabe generated | replaced | weak | kept
//
// Werte gehen nie ueber die Kommandozeile (sonst in der Prozessliste lesbar):
// `set` liest ENV_TOOL_VALUE, `ensure` erzeugt das Secret selbst. Schreiben
// ersetzt jede Zeile KEY=... woertlich (keine sed-/Regex-Ersatzzeichen), haengt
// sonst an, behaelt CRLF/LF bei, schreibt UTF-8 ohne BOM atomar und setzt den
// Dateimodus auf 0600 (ausser Windows).
// =============================================================================

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/config/src/dev-default-secrets.json',
);
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvToolError extends Error {}

function fail(message) {
  throw new EnvToolError(message);
}

function readLines(file) {
  if (!existsSync(file)) return { lines: [], eol: '\n' };
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return { lines, eol };
}

function writeLines(file, lines, eol) {
  const temp = join(dirname(file), `${basename(file)}.${process.pid}.tmp`);
  writeFileSync(temp, lines.length > 0 ? lines.join(eol) + eol : '', { mode: 0o600 });
  renameSync(temp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

function requireKey(key) {
  if (!KEY_PATTERN.test(key ?? '')) fail(`Ungueltiger Schluessel: ${key ?? '(fehlt)'}`);
  return key;
}

/** Wie `grep -E "^KEY=" | head -n1 | cut -d= -f2- | tr -d '"'` in ops-lib.sh. */
export function getValue(file, key) {
  const prefix = `${requireKey(key)}=`;
  const line = readLines(file).lines.find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? '' : line.slice(prefix.length).replaceAll('"', '');
}

/** Setzt KEY=value woertlich; true, wenn sich die Datei aendert. */
export function setValue(file, key, value) {
  const prefix = `${requireKey(key)}=`;
  if (/[\r\n]/.test(value)) fail(`${key}: Wert darf keinen Zeilenumbruch enthalten.`);
  const { lines, eol } = readLines(file);
  const wanted = prefix + value;
  let found = false;
  const next = lines.map((line) => {
    if (!line.startsWith(prefix)) return line;
    found = true;
    return wanted;
  });
  if (!found) next.push(wanted);
  const changed = !existsSync(file) || next.join('\n') !== lines.join('\n');
  writeLines(file, next, eol);
  return changed;
}

export function unsetValue(file, key) {
  const prefix = `${requireKey(key)}=`;
  const { lines, eol } = readLines(file);
  const next = lines.filter((line) => !line.startsWith(prefix));
  if (next.length === lines.length) return false;
  writeLines(file, next, eol);
  return true;
}

export function generateSecret(bytes) {
  const size = Number(bytes);
  if (!Number.isInteger(size) || size < 16 || size > 128) fail(`Ungueltige Laenge: ${bytes}`);
  return randomBytes(size).toString('base64url');
}

let defaults;
function devDefaults() {
  defaults ??= JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8'));
  return defaults;
}

/** Leer, bekannter Dev-/CI-Default oder (AUTH_SECRET) Woerterbuch-/Wiederholungsmuster. */
export function isWeakSecret(key, value) {
  if (!value) return true;
  const { values, authSecretPatterns } = devDefaults();
  if ((values[key] ?? []).includes(value)) return true;
  return (
    key === 'AUTH_SECRET' &&
    authSecretPatterns.some(({ source, flags }) => new RegExp(source, flags).test(value))
  );
}

export function ensureSecret(file, key, bytes, { replaceWeak = false } = {}) {
  const current = getValue(file, key);
  if (!current) {
    setValue(file, key, generateSecret(bytes));
    return 'generated';
  }
  if (!isWeakSecret(key, current)) return 'kept';
  if (!replaceWeak) return 'weak';
  setValue(file, key, generateSecret(bytes));
  return 'replaced';
}

export function run(argv, env = process.env) {
  const [command, ...args] = argv;
  switch (command) {
    case 'get':
      return getValue(args[0], args[1]);
    case 'set':
      if (env.ENV_TOOL_VALUE === undefined) fail('set: ENV_TOOL_VALUE fehlt.');
      return setValue(args[0], args[1], env.ENV_TOOL_VALUE) ? 'changed' : 'unchanged';
    case 'unset':
      return unsetValue(args[0], args[1]) ? 'changed' : 'unchanged';
    case 'secret':
      return generateSecret(args[0]);
    case 'weak':
      return isWeakSecret(requireKey(args[1]), getValue(args[0], args[1])) ? 'weak' : 'ok';
    case 'ensure':
      if (args.length > 4 || (args[3] !== undefined && args[3] !== '--replace-weak')) {
        fail(`ensure: unbekannte Option ${args[3]}`);
      }
      return ensureSecret(args[0], args[1], args[2], { replaceWeak: args[3] === '--replace-weak' });
    default:
      return fail(`Unbekannter Befehl: ${command ?? '(fehlt)'}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const output = run(process.argv.slice(2));
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`env-tool: ${error.message}\n`);
    process.exitCode = 2;
  }
}
