import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ensureSecret,
  generateSecret,
  getValue,
  isWeakSecret,
  setValue,
  unsetValue,
} from '../env-tool.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'scripts/env-tool.mjs');
const DEFAULTS = JSON.parse(
  readFileSync(join(ROOT, 'packages/config/src/dev-default-secrets.json'), 'utf8'),
);
const dir = mkdtempSync(join(tmpdir(), 'env-tool-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function envFile(content) {
  const file = join(dir, `case-${counter++}.env`);
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

function cli(args, value) {
  const env = { ...process.env };
  delete env.ENV_TOOL_VALUE;
  if (value !== undefined) env.ENV_TOOL_VALUE = value;
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env });
}

const TRICKY = [
  'a|b&c\\d/e',
  'p$1$$&{x}',
  'with "quotes" and \'single\'',
  '  padded  ',
  '=lead=eq=',
];

test('set schreibt Werte woertlich und get liest sie wie ops-lib get_env', () => {
  for (const value of TRICKY) {
    const file = envFile('A=1\nKEY=old\nB=2\n');
    assert.equal(setValue(file, 'KEY', value), true);
    assert.equal(readFileSync(file, 'utf8'), `A=1\nKEY=${value}\nB=2\n`);
    assert.equal(getValue(file, 'KEY'), value.replaceAll('"', ''));
  }
});

test('set ersetzt jede Zeile des Schluessels, haengt sonst an und behaelt CRLF', () => {
  const duplicate = envFile('KEY=a\nKEYX=keep\nKEY=b\n');
  setValue(duplicate, 'KEY', 'new');
  assert.equal(readFileSync(duplicate, 'utf8'), 'KEY=new\nKEYX=keep\nKEY=new\n');

  const noTrailingNewline = envFile('A=1');
  setValue(noTrailingNewline, 'NEW', 'v');
  assert.equal(readFileSync(noTrailingNewline, 'utf8'), 'A=1\nNEW=v\n');

  const crlf = envFile('﻿A=1\r\nKEY=old\r\n');
  setValue(crlf, 'KEY', 'x');
  setValue(crlf, 'ADDED', 'y');
  assert.equal(readFileSync(crlf, 'utf8'), 'A=1\r\nKEY=x\r\nADDED=y\r\n');
  assert.equal(getValue(crlf, 'ADDED'), 'y');

  assert.equal(setValue(crlf, 'KEY', 'x'), false);
});

test(
  'set legt die Datei mit 0600 an und haelt den Modus',
  { skip: process.platform === 'win32' },
  () => {
    const file = envFile();
    setValue(file, 'KEY', 'v');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const open = envFile('KEY=v\n');
    setValue(open, 'KEY', 'w');
    assert.equal(statSync(open).mode & 0o777, 0o600);
  },
);

test('unset entfernt alle Zeilen des Schluessels', () => {
  const file = envFile('KEY=a\nKEEP=1\nKEY=b\n');
  assert.equal(unsetValue(file, 'KEY'), true);
  assert.equal(readFileSync(file, 'utf8'), 'KEEP=1\n');
  assert.equal(unsetValue(file, 'KEY'), false);
});

test('secret liefert base64url ohne Padding', () => {
  const secret = generateSecret(32);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(secret, generateSecret(32));
  assert.match(generateSecret(24), /^[A-Za-z0-9_-]{32}$/);
});

test('weak erkennt jeden Default aus @taxtronik/config und AUTH_SECRET-Muster', () => {
  for (const [key, values] of Object.entries(DEFAULTS.values)) {
    for (const value of values) assert.equal(isWeakSecret(key, value), true, `${key}=${value}`);
  }
  assert.equal(isWeakSecret('AUTH_SECRET', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(isWeakSecret('AUTH_SECRET', 'Password1234password1234password'), true);
  assert.equal(isWeakSecret('POSTGRES_PASSWORD', ''), true);
  assert.equal(isWeakSecret('AUTH_SECRET', generateSecret(32)), false);
  // Muster gelten nur fuer AUTH_SECRET, wie im Prod-Gate.
  assert.equal(isWeakSecret('N8N_HMAC_SECRET', 'password-with-more-than-thirty-two-chars'), false);
});

test('ensure erzeugt leere Secrets und ersetzt schwache nur auf Anforderung', () => {
  const file = envFile(
    'AUTH_SECRET=\nN8N_HMAC_SECRET=dev-only-hmac-secret-min-32-chars-long-xxx\n',
  );
  assert.equal(ensureSecret(file, 'AUTH_SECRET', 32), 'generated');
  const generated = getValue(file, 'AUTH_SECRET');
  assert.match(generated, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ensureSecret(file, 'AUTH_SECRET', 32, { replaceWeak: true }), 'kept');
  assert.equal(getValue(file, 'AUTH_SECRET'), generated);

  assert.equal(ensureSecret(file, 'N8N_HMAC_SECRET', 32), 'weak');
  assert.equal(getValue(file, 'N8N_HMAC_SECRET'), 'dev-only-hmac-secret-min-32-chars-long-xxx');
  assert.equal(ensureSecret(file, 'N8N_HMAC_SECRET', 32, { replaceWeak: true }), 'replaced');
  assert.equal(isWeakSecret('N8N_HMAC_SECRET', getValue(file, 'N8N_HMAC_SECRET')), false);

  assert.equal(ensureSecret(file, 'MISSING_KEY', 24), 'generated');
  assert.match(getValue(file, 'MISSING_KEY'), /^[A-Za-z0-9_-]{32}$/);
});

test('CLI: Werte nur ueber ENV_TOOL_VALUE, Fehler mit Exit 2', () => {
  const file = envFile('KEY=old\n');
  assert.equal(cli(['set', file, 'KEY']).status, 2);
  assert.equal(cli(['set', file, 'KEY'], 'a\nINJECTED=1').status, 2);
  assert.equal(readFileSync(file, 'utf8'), 'KEY=old\n');
  const set = cli(['set', file, 'KEY'], 'p|$1&');
  assert.equal(set.status, 0);
  assert.equal(set.stdout, 'changed\n');
  assert.equal(cli(['get', file, 'KEY']).stdout, 'p|$1&\n');
  assert.equal(cli(['get', file, 'ABSENT']).stdout, '');
  assert.equal(cli(['weak', file, 'KEY']).stdout, 'ok\n');
  assert.equal(cli(['weak', file, 'ABSENT']).stdout, 'weak\n');
  assert.equal(cli(['ensure', file, 'NEW', '32']).stdout, 'generated\n');
  assert.equal(cli(['ensure', file, 'NEW', '32', '--force']).status, 2);
  assert.equal(cli(['get', file, 'bad key']).status, 2);
  assert.equal(cli(['nope']).status, 2);
});

test(
  'Paritaet mit set_env/get_env aus scripts/ops-lib.sh',
  { skip: spawnSync('bash', ['-c', 'true']).status !== 0 },
  () => {
    for (const value of TRICKY) {
      const viaTool = envFile('A=1\nKEY=old\n');
      const viaShell = envFile('A=1\nKEY=old\n');
      setValue(viaTool, 'KEY', value);
      setValue(viaTool, 'ADDED', value);
      const shell = spawnSync(
        'bash',
        [
          '-c',
          'source "$1/scripts/ops-lib.sh" >/dev/null; ENVFILE="$2"; ' +
            'set_env KEY "$3"; set_env ADDED "$3"; get_env KEY',
          'parity',
          ROOT,
          viaShell,
          value,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(shell.status, 0, shell.stderr);
      assert.equal(readFileSync(viaShell, 'utf8'), readFileSync(viaTool, 'utf8'), value);
      assert.equal(shell.stdout, `${getValue(viaTool, 'KEY')}\n`, value);
    }
  },
);
