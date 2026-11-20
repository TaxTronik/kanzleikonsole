// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { psql } from '../tests/helpers/postgres.ts';

const query = 'SELECT\n\'fixture "value"\'';
const url = 'postgresql://url-user:url-pass@localhost:15436/clone_17?schema=public';
const pg = {
  PGHOST: '127.0.0.1',
  PGPORT: '15436',
  PGUSER: 'seed-user',
  PGPASSWORD: 'seed-pass',
  PGDATABASE: 'clone_17',
};

test('psql liest beim fehlenden E2E_POSTGRES_DB den libpq-Klon mit dessen Port', () => {
  const result = psql(query, { DATABASE_URL: url, ...pg }, (file, args, options) => {
    assert.equal(file, 'psql');
    assert.deepEqual(args, [
      '-h',
      '127.0.0.1',
      '-p',
      '15436',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'seed-user',
      '-d',
      'clone_17',
      '-t',
      '-A',
      '-c',
      query,
    ]);
    assert.equal(options.env.PGPASSWORD, 'seed-pass');
    return ' clone_17\n';
  });
  assert.equal(result, 'clone_17');
});

test('explizite E2E-Werte überschreiben libpq-Werte und das Passwort bleibt außerhalb der Argumente', () => {
  psql(
    query,
    {
      DATABASE_URL: url,
      ...pg,
      PGDATABASE: 'old',
      E2E_POSTGRES_DB: 'clone_17',
      E2E_POSTGRES_HOST: 'test-proxy',
      E2E_POSTGRES_PORT: '15438',
      E2E_POSTGRES_USER: 'fixture',
      E2E_POSTGRES_PASSWORD: 'fixture-pass',
    },
    (file, args, options) => {
      assert.equal(file, 'psql');
      assert.deepEqual(args.slice(0, 4), ['-h', 'test-proxy', '-p', '15438']);
      assert.equal(args[args.indexOf('-d') + 1], 'clone_17');
      assert.equal(args[args.indexOf('-U') + 1], 'fixture');
      assert.equal(options.env.PGPASSWORD, 'fixture-pass');
      assert.ok(!args.includes('fixture-pass'));
      return '';
    },
  );
});

test('aus DATABASE_URL allein werden der URL-kodierte Name und der Zielport übernommen', () => {
  psql(
    query,
    { DATABASE_URL: 'postgresql://url-user:url-pass@localhost:15437/clone%20three' },
    (_file, args, options) => {
      assert.deepEqual(args.slice(0, 4), ['-h', 'localhost', '-p', '15437']);
      assert.equal(args[args.indexOf('-d') + 1], 'clone three');
      assert.equal(args[args.indexOf('-U') + 1], 'url-user');
      assert.equal(options.env.PGPASSWORD, 'url-pass');
      return '';
    },
  );
});

test('ein widersprüchlicher Datenbankname bricht vor jedem Prozessaufruf ab', () => {
  let calls = 0;
  for (const mismatch of [{ PGDATABASE: 'old' }, { ...pg, E2E_POSTGRES_DB: 'old' }]) {
    assert.throws(
      () =>
        psql(query, { DATABASE_URL: url, ...mismatch }, () => {
          calls++;
          return '';
        }),
      /unterschiedliche Datenbanken/,
    );
  }
  assert.equal(calls, 0);
});

test('nur das fehlende lokale psql darf beim Standardport einmal auf den Dev-Container wechseln', () => {
  const files: string[] = [];
  psql(query, {}, (file, args) => {
    files.push(file);
    if (file === 'psql') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    assert.ok(args.includes('taxtronik-postgres'));
    assert.equal(args[args.indexOf('-d') + 1], 'taxtronik');
    return '';
  });
  assert.deepEqual(files, ['psql', 'docker']);
  for (const [env, code] of [
    [pg, 'ENOENT'],
    [{}, 'SQL-error'],
  ] as const) {
    let calls = 0;
    assert.throws(() =>
      psql(query, env, () => {
        calls++;
        throw Object.assign(new Error('failure'), { code });
      }),
    );
    assert.equal(calls, 1);
  }
});

test('ein expliziter Container erhält die SQL unverändert als einzelnes Argument', () => {
  psql(query, { ...pg, E2E_POSTGRES_CONTAINER: 'clone-container' }, (file, args, options) => {
    assert.equal(file, 'docker');
    assert.deepEqual(args.slice(0, 6), [
      'exec',
      '--env',
      'PGPASSWORD',
      '--',
      'clone-container',
      'psql',
    ]);
    assert.equal(args.at(-1), query);
    assert.equal(args[args.indexOf('-d') + 1], 'clone_17');
    assert.ok(!args.includes('seed-pass'));
    assert.equal(options.env.PGPASSWORD, 'seed-pass');
    return '';
  });
});
