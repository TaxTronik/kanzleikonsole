// Review-Finding D-01: kanonische SQL-Quellen (pnpm db:sql:dump | db:sql:check |
// db:sql:migration). Normalisierung, Dateinamen, Rendering, Vergleich mit lesbarem
// Diff, Migrationsgerüst, CI-Verdrahtung und Hygiene der eingecheckten Dateien.
// Der Rundlauf gegen PostgreSQL steht in sql-sources-db.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MIGRATION_TODO_MARKER,
  buildSqlSources,
  compareSqlSources,
  findRuleCandidates,
  findUnfinishedMigrations,
  formatDriftReport,
  functionSourcePath,
  hasDrift,
  migrationDirectoryName,
  normalizeSql,
  objectReference,
  parseFunctionSignature,
  parsePolicyTarget,
  parseTriggerTarget,
  readRepositorySources,
  renderFunction,
  renderMigration,
  renderPolicy,
  renderTrigger,
  sortedSources,
  splitTopLevel,
  tableObjectSourcePath,
  unifiedDiff,
  utcMigrationTimestamp,
  type CanonicalChange,
  type FunctionRow,
  type PolicyRow,
  type TriggerRow,
} from '../../scripts/sql-sources';

type Step = { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean };
type Job = { steps: Step[]; if?: string; 'continue-on-error'?: boolean };
type Workflow = { jobs: Record<string, Job> };

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const readText = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = yaml.load(readText('../../../../.forgejo/workflows/ci.yml'));
const rootPackage = JSON.parse(readText('../../../../package.json')) as {
  scripts: Record<string, string>;
};
const dbPackage = JSON.parse(readText('../../package.json')) as {
  scripts: Record<string, string>;
};
const SQL_ROOT = fileURLToPath(new URL('../../prisma/sql', import.meta.url));

function functionRow(overrides: Partial<FunctionRow> = {}): FunctionRow {
  return {
    schema: 'app',
    name: 'touch',
    kind: 'f',
    arg_types: ['uuid'],
    definition:
      'CREATE OR REPLACE FUNCTION app.touch(p_id uuid)\n RETURNS void\n LANGUAGE sql\n' +
      'AS $function$ SELECT 1 $function$\n',
    ...overrides,
  };
}

function triggerRow(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    schema: 'public',
    table_name: 'client',
    name: 'client_touch',
    enabled: 'O',
    qualified_table: 'public.client',
    quoted_name: 'client_touch',
    definition:
      'CREATE TRIGGER client_touch BEFORE UPDATE ON public.client FOR EACH ROW EXECUTE FUNCTION app.touch()',
    ...overrides,
  };
}

function policyRow(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    schema: 'public',
    table_name: 'client',
    name: 'client_isolation',
    qualified_table: 'public.client',
    quoted_name: 'client_isolation',
    permissive: 'PERMISSIVE',
    roles: ['PUBLIC'],
    command: 'ALL',
    qual: '(tenant_id = app.current_tenant_id())',
    with_check: '(tenant_id = app.current_tenant_id())',
    ...overrides,
  };
}

const NO_DRIFT = { changed: [], missing: [], unexpected: [], unnormalized: [] };

describe('normalizeSql', () => {
  it('vereinheitlicht CRLF, Leerraum am Zeilenende und das Dateiende', () => {
    expect(normalizeSql('a  \r\nb\t\r\n\r\n\r\n')).toBe('a\nb\n');
    expect(normalizeSql('x\n\n  y')).toBe('x\n\n  y\n');
    expect(normalizeSql('')).toBe('\n');
  });

  it('ist idempotent', () => {
    const once = normalizeSql('CREATE POLICY p ON t \r\n  USING (true);  \n\n');
    expect(normalizeSql(once)).toBe(once);
  });
});

describe('Rendering und Dateinamen', () => {
  it('schreibt Funktionen als ein Statement mit Semikolon', () => {
    expect(renderFunction(functionRow())).toBe(
      'CREATE OR REPLACE FUNCTION app.touch(p_id uuid)\n RETURNS void\n LANGUAGE sql\n' +
        'AS $function$ SELECT 1 $function$;\n',
    );
  });

  it('lehnt Aggregate und Fensterfunktionen ab', () => {
    expect(() => renderFunction(functionRow({ kind: 'a', definition: null }))).toThrow(
      /nicht unterstützt/,
    );
  });

  it('bildet plattformsichere Dateinamen aus Schema, Name und Argumenttypen', () => {
    expect(
      functionSourcePath({
        schema: 'app',
        name: 'f',
        arg_types: ['uuid', 'timestamptz', 'public.notification_kind', 'text[]'],
      }),
    ).toBe('functions/app.f(uuid,timestamptz,public.notification_kind,text[]).sql');
    expect(functionSourcePath({ schema: 'app', name: 'we"ird name', arg_types: [] })).toBe(
      'functions/app.we_ird_name().sql',
    );
    expect(tableObjectSourcePath('triggers', 'public', 'client', '00_pair')).toBe(
      'triggers/client.00_pair.sql',
    );
    expect(tableObjectSourcePath('policies', 'app', 'job', 'job/select')).toBe(
      'policies/app.job.job_select.sql',
    );
  });

  it('hält einen vom Standard abweichenden Triggerzustand fest', () => {
    expect(renderTrigger(triggerRow())).toBe(`${triggerRow().definition};\n`);
    expect(renderTrigger(triggerRow({ enabled: 'D' }))).toBe(
      `${triggerRow().definition};\nALTER TABLE public.client DISABLE TRIGGER client_touch;\n`,
    );
    expect(renderTrigger(triggerRow({ enabled: 'A' }))).toContain('ENABLE ALWAYS TRIGGER');
    expect(() => renderTrigger(triggerRow({ enabled: 'X' }))).toThrow(/Triggerzustand/);
  });

  it('schreibt Policies mit allen Klauseln und sortierten Rollen', () => {
    expect(renderPolicy(policyRow())).toBe(
      'CREATE POLICY client_isolation ON public.client\n' +
        '  AS PERMISSIVE\n  FOR ALL\n  TO PUBLIC\n' +
        '  USING ((tenant_id = app.current_tenant_id()))\n' +
        '  WITH CHECK ((tenant_id = app.current_tenant_id()));\n',
    );
    expect(
      renderPolicy(
        policyRow({
          permissive: 'RESTRICTIVE',
          command: 'INSERT',
          roles: ['taxtronik_worker', 'taxtronik_app'],
          qual: null,
        }),
      ),
    ).toBe(
      'CREATE POLICY client_isolation ON public.client\n' +
        '  AS RESTRICTIVE\n  FOR INSERT\n  TO taxtronik_app, taxtronik_worker\n' +
        '  WITH CHECK ((tenant_id = app.current_tenant_id()));\n',
    );
    expect(() => renderPolicy(policyRow({ command: 'MERGE' }))).toThrow(/Policy-Art/);
  });

  it('sortiert nach Codepunkten und weist Kollisionen ab', () => {
    const sources = buildSqlSources({
      functions: [functionRow({ name: 'b' }), functionRow({ name: 'B_upper' })],
      triggers: [triggerRow()],
      policies: [policyRow()],
    });
    expect([...sources.keys()]).toEqual([
      'functions/app.B_upper(uuid).sql',
      'functions/app.b(uuid).sql',
      'policies/client.client_isolation.sql',
      'triggers/client.client_touch.sql',
    ]);
    expect(() =>
      buildSqlSources({ functions: [], triggers: [triggerRow(), triggerRow()], policies: [] }),
    ).toThrow(/Doppelter Quellpfad/);
    expect(() =>
      buildSqlSources({
        functions: [functionRow({ name: 'Touch' }), functionRow()],
        triggers: [],
        policies: [],
      }),
    ).toThrow(/Schreibweise/);
  });
});

describe('Vergleich und Bericht', () => {
  const database = sortedSources([
    ['functions/app.a().sql', 'A\nB\nC\n'],
    ['policies/t.p.sql', 'P\n'],
    ['triggers/t.x.sql', 'X\n'],
  ]);

  it('meldet keinen Unterschied für identische Stände', () => {
    const drift = compareSqlSources(database, new Map(database));
    expect(drift).toEqual(NO_DRIFT);
    expect(hasDrift(drift)).toBe(false);
  });

  it('unterscheidet geänderte, fehlende, unerwartete und nicht normalisierte Dateien', () => {
    const repository = sortedSources([
      ['functions/app.a().sql', 'A\nB2\nC\n'],
      ['triggers/t.x.sql', 'X\r\n'],
      ['triggers/t.y.sql', 'Y'],
    ]);
    const drift = compareSqlSources(database, repository);
    expect(drift).toEqual({
      changed: ['functions/app.a().sql'],
      missing: ['policies/t.p.sql'],
      unexpected: ['triggers/t.y.sql'],
      // Nur CRLF ist kein Inhaltsunterschied, aber ein Hygienefehler.
      unnormalized: ['triggers/t.x.sql', 'triggers/t.y.sql'],
    });
    const report = formatDriftReport(drift, database, repository, 'sql');
    expect(report).toContain('--- sql/functions/app.a().sql (Repository)');
    expect(report).toContain('+++ sql/functions/app.a().sql (Datenbank)');
    expect(report).toContain('@@ -1,3 +1,3 @@\n A\n-B2\n+B\n C');
    expect(report).toContain(
      'Nur in der Datenbank, Datei fehlt im Repository (1):\n  policies/t.p.sql',
    );
    expect(report).toContain(
      'Nur im Repository, Objekt fehlt in der Datenbank (1):\n  triggers/t.y.sql',
    );
    expect(report).toMatch(
      /Nicht normalisiert .* \(2\):\n {2}triggers\/t\.x\.sql\n {2}triggers\/t\.y\.sql/,
    );
  });
});

describe('unifiedDiff', () => {
  const labels = { before: 'a', after: 'b' };
  const lines = (count: number, prefix = 'l') =>
    Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

  it('ist leer für gleiche Texte', () => {
    expect(unifiedDiff('x\n', 'x\n', labels)).toBe('');
  });

  it('zeigt Änderungen mit drei Zeilen Kontext und getrennten Hunks', () => {
    const before = `${lines(20).join('\n')}\n`;
    const after = `${lines(20)
      .map((line) => (line === 'l2' ? 'L2' : line === 'l17' ? 'L17' : line))
      .join('\n')}\n`;
    expect(unifiedDiff(before, after, labels)).toBe(
      [
        '--- a',
        '+++ b',
        '@@ -1,5 +1,5 @@',
        ' l1',
        '-l2',
        '+L2',
        ' l3',
        ' l4',
        ' l5',
        '@@ -14,7 +14,7 @@',
        ' l14',
        ' l15',
        ' l16',
        '-l17',
        '+L17',
        ' l18',
        ' l19',
        ' l20',
        '',
      ].join('\n'),
    );
  });

  it('zählt reine Einfügungen und Löschungen korrekt', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\nc\n', labels)).toBe(
      '--- a\n+++ b\n@@ -1,2 +1,3 @@\n a\n b\n+c\n',
    );
    expect(unifiedDiff('a\nb\n', 'b\n', labels)).toBe('--- a\n+++ b\n@@ -1,2 +1,1 @@\n-a\n b\n');
    expect(unifiedDiff('', 'a\n', labels)).toBe('--- a\n+++ b\n@@ -0,0 +1,1 @@\n+a\n');
  });

  it('bleibt bei sehr großen Abweichungen begrenzt', () => {
    const before = `${lines(2100).join('\n')}\n`;
    const after = `${lines(2100, 'x').join('\n')}\n`;
    const diff = unifiedDiff(before, after, labels);
    expect(diff.split('\n')[2]).toBe('@@ -1,2100 +1,2100 @@');
    expect(diff.split('\n')).toHaveLength(3 + 4200 + 1);
  });
});

describe('Parser für das Migrationsgerüst', () => {
  it('liest die Funktionssignatur ohne Defaults', () => {
    expect(
      parseFunctionSignature(
        'CREATE OR REPLACE FUNCTION app."Weird"(p_a uuid, p_b text DEFAULT \'a,b\'::text, ' +
          'p_c integer[] DEFAULT ARRAY[1, 2], p_at timestamp with time zone, OUT p_d boolean)\n' +
          ' RETURNS record\n LANGUAGE sql\nAS $function$ SELECT 1 $function$;\n',
      ),
    ).toEqual({
      objectType: 'FUNCTION',
      qualifiedName: 'app."Weird"',
      identityArguments:
        'p_a uuid, p_b text, p_c integer[], p_at timestamp with time zone, OUT p_d boolean',
    });
    expect(
      parseFunctionSignature('CREATE PROCEDURE public.p()\n LANGUAGE sql\nAS $x$ $x$;'),
    ).toEqual({ objectType: 'PROCEDURE', qualifiedName: 'public.p', identityArguments: '' });
    expect(splitTopLevel('a, f(b, c), \'d,e\', "g,h" text')).toEqual([
      'a',
      'f(b, c)',
      "'d,e'",
      '"g,h" text',
    ]);
    expect(() => parseFunctionSignature('CREATE POLICY p ON t;')).toThrow(/CREATE/);
  });

  it('liest Name und Tabelle eines Triggers, auch bei quotierten Spalten', () => {
    expect(
      parseTriggerTarget(
        'CREATE TRIGGER "on" BEFORE UPDATE OF "on", status ON public."Tbl" FOR EACH ROW ' +
          "WHEN ((new.status <> 'ON'::text)) EXECUTE FUNCTION app.f();\n",
      ),
    ).toEqual({ quotedName: '"on"', qualifiedTable: 'public."Tbl"' });
    expect(
      parseTriggerTarget(
        'CREATE CONSTRAINT TRIGGER c AFTER INSERT ON public.t DEFERRABLE INITIALLY DEFERRED ' +
          'FOR EACH ROW EXECUTE FUNCTION app.f();\n',
      ),
    ).toEqual({ quotedName: 'c', qualifiedTable: 'public.t' });
    expect(() => parseTriggerTarget('DROP TRIGGER x ON t;')).toThrow(/CREATE/);
  });

  it('liest Name und Tabelle einer Policy', () => {
    expect(parsePolicyTarget(renderPolicy(policyRow()))).toEqual({
      quotedName: 'client_isolation',
      qualifiedTable: 'public.client',
    });
    expect(parsePolicyTarget('CREATE POLICY "Mixed Case" ON app."T"\n  FOR ALL;')).toEqual({
      quotedName: '"Mixed Case"',
      qualifiedTable: 'app."T"',
    });
    expect(() => parsePolicyTarget('CREATE TRIGGER x ON t;')).toThrow(/CREATE POLICY/);
  });
});

describe('Migrationsgerüst', () => {
  const fnBefore = renderFunction(functionRow());
  const fnAfter = fnBefore.replace('SELECT 1', 'SELECT 2');
  const trigger = renderTrigger(triggerRow());
  const policy = renderPolicy(policyRow());

  function render(changes: CanonicalChange[], ruleIds = ['ACCESS-TENANT-RLS-001']) {
    return renderMigration(changes, { ruleIds });
  }

  it('folgt dem Migrationsstil: Kopfkommentar, BEGIN/COMMIT, LF', () => {
    const sql = render([
      { path: 'functions/app.touch(uuid).sql', before: fnBefore, after: fnAfter },
    ]);
    expect(sql).toBe(
      [
        '-- ACCESS-TENANT-RLS-001.',
        '--',
        `-- ${MIGRATION_TODO_MARKER}: Anlass, Änderung und Verhalten beschreiben.`,
        '--',
        '-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql',
        '-- (docs/development/kanonische-sql-quellen.md):',
        '--   geändert: functions/app.touch(uuid).sql',
        'BEGIN;',
        '',
        fnAfter.trimEnd(),
        '',
        'COMMIT;',
        '',
      ].join('\n'),
    );
    expect(sql).not.toContain('\r');
  });

  it('ersetzt Trigger und Policies per DROP + CREATE in abhängigkeitsfester Reihenfolge', () => {
    const triggerAfter = trigger.replace('BEFORE UPDATE', 'BEFORE INSERT OR UPDATE');
    const sql = render([
      { path: 'triggers/client.client_touch.sql', before: trigger, after: triggerAfter },
      { path: 'policies/client.client_isolation.sql', before: policy, after: null },
      { path: 'functions/app.touch(uuid).sql', before: fnBefore, after: fnAfter },
    ]);
    const order = [
      'DROP POLICY client_isolation ON public.client;',
      'DROP TRIGGER client_touch ON public.client;',
      'CREATE OR REPLACE FUNCTION app.touch(p_id uuid)',
      'CREATE TRIGGER client_touch BEFORE INSERT OR UPDATE ON public.client',
    ].map((needle) => sql.indexOf(needle));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sql).toContain('--   entfernt: policies/client.client_isolation.sql');
    expect(sql).toContain('--   geändert: triggers/client.client_touch.sql');
  });

  it('legt neue Objekte an und entfernt entfallene Funktionen zuletzt', () => {
    const sql = render([
      { path: 'policies/client.client_isolation.sql', before: null, after: policy },
      { path: 'functions/app.touch(uuid).sql', before: fnBefore, after: null },
      { path: 'triggers/client.client_touch.sql', before: trigger, after: null },
    ]);
    expect(sql).toContain('--   neu:      policies/client.client_isolation.sql');
    expect(sql.indexOf('CREATE POLICY client_isolation')).toBeGreaterThan(
      sql.indexOf('DROP TRIGGER client_touch ON public.client;'),
    );
    expect(sql.trimEnd().split('\n').slice(-3)).toEqual([
      'DROP FUNCTION app.touch(p_id uuid);',
      '',
      'COMMIT;',
    ]);
  });

  it('markiert Signatur- und Rückgabeänderungen zur Prüfung', () => {
    const renamedArgs = fnBefore.replace(
      '(p_id uuid)',
      '(p_id uuid, p_flag boolean DEFAULT false)',
    );
    const signature = render([
      { path: 'functions/app.touch(uuid).sql', before: fnBefore, after: renamedArgs },
    ]);
    expect(signature).toContain(`${MIGRATION_TODO_MARKER}: Signatur von app.touch geändert`);
    expect(signature.trimEnd()).toMatch(/DROP FUNCTION app\.touch\(p_id uuid\);\n\nCOMMIT;$/);
    const returns = render([
      {
        path: 'functions/app.touch(uuid).sql',
        before: fnBefore,
        after: fnBefore.replace('RETURNS void', 'RETURNS integer'),
      },
    ]);
    expect(returns).toContain(`${MIGRATION_TODO_MARKER}: Rückgabetyp von app.touch geändert`);
    expect(returns).not.toContain('DROP FUNCTION');
  });

  it('kennzeichnet abgeleitete oder fehlende Regel-IDs als Platzhalter', () => {
    const change = { path: 'functions/app.touch(uuid).sql', before: fnBefore, after: fnAfter };
    const derived = renderMigration([change], {
      ruleIds: ['A-B-001', 'C-D-002'],
      ruleIdSource: '20260101000000_x',
    });
    expect(derived.split('\n').slice(0, 2)).toEqual([
      '-- A-B-001 / C-D-002.',
      `-- ${MIGRATION_TODO_MARKER}: Regel-IDs prüfen (abgeleitet aus 20260101000000_x).`,
    ]);
    expect(renderMigration([change], { ruleIds: [] }).split('\n')[0]).toBe(
      `-- ${MIGRATION_TODO_MARKER}: Fachkatalog-Regel-IDs nennen.`,
    );
    expect(() => render([{ ...change, after: fnBefore }])).toThrow(/Keine geänderten/);
    expect(() => render([{ path: 'views/x.sql', before: null, after: 'x' }])).toThrow(
      /Keine kanonische/,
    );
  });
});

describe('Regel-ID-Kandidaten', () => {
  const catalog = [
    { id: 'RULE-OLD-001' },
    { id: 'RULE-HEAD-001' },
    { id: 'RULE-REF-001', code_refs: ['packages/db/prisma/migrations/20260302_b/migration.sql'] },
  ];
  const migrations = [
    {
      name: '20260301_a',
      sql: '-- RULE-OLD-001.\nBEGIN;\nCREATE FUNCTION app.f() RETURNS void AS $$ $$ LANGUAGE sql;\nCOMMIT;\n',
    },
    {
      name: '20260302_b',
      sql: '-- Ohne Regel-ID, aber in code_refs.\nCREATE OR REPLACE FUNCTION "app"."f"()\n RETURNS void;\n',
    },
    // Erwähnt die Funktion nur, ohne sie zu definieren.
    { name: '20260303_c', sql: '-- RULE-HEAD-001.\nSELECT app.f();\n' },
    {
      name: '20260304_d',
      sql:
        '-- RULE-HEAD-001 / SHA-256.\nDROP TRIGGER t ON other;\n' +
        'CREATE TRIGGER t BEFORE UPDATE ON public.client FOR EACH ROW EXECUTE FUNCTION app.f();\n' +
        'CREATE POLICY p ON "client" FOR ALL USING (true);\n',
    },
  ];

  it('nimmt die jüngste definierende Migration mit Regel-IDs', () => {
    expect(findRuleCandidates([{ kind: 'functions', name: 'app.f' }], migrations, catalog)).toEqual(
      { ruleIds: ['RULE-REF-001'], sources: ['20260302_b'] },
    );
    expect(
      findRuleCandidates(
        [
          { kind: 'triggers', name: 't', table: 'client' },
          { kind: 'policies', name: 'p', table: 'client' },
        ],
        migrations,
        catalog,
      ),
    ).toEqual({ ruleIds: ['RULE-HEAD-001'], sources: ['20260304_d'] });
  });

  it('trennt gleichnamige Trigger verschiedener Tabellen', () => {
    expect(
      findRuleCandidates([{ kind: 'triggers', name: 't', table: 'other' }], migrations, catalog),
    ).toEqual({ ruleIds: [], sources: [] });
  });

  it('leitet die Objekte aus den Quelldateien ab', () => {
    expect(objectReference('functions/app.touch(uuid).sql', renderFunction(functionRow()))).toEqual(
      { kind: 'functions', name: 'app.touch' },
    );
    expect(
      objectReference('triggers/client.client_touch.sql', renderTrigger(triggerRow())),
    ).toEqual({ kind: 'triggers', name: 'client_touch', table: 'client' });
    expect(
      objectReference('policies/T.Mixed.sql', 'CREATE POLICY "Mixed" ON public."T"\n  FOR ALL;'),
    ).toEqual({ kind: 'policies', name: 'Mixed', table: 'T' });
  });
});

describe('Migrationsverzeichnis', () => {
  it('nutzt UTC-Zeitstempel hinter der jüngsten Migration', () => {
    expect(utcMigrationTimestamp(new Date('2026-10-06T17:05:09.123Z'))).toBe('20261006170509');
    const existing = ['20261006130100_storage_upload_intent', 'migration_lock.toml'];
    expect(migrationDirectoryName(existing, '20261006170000', 'canonical_change')).toBe(
      '20261006170000_canonical_change',
    );
    expect(() => migrationDirectoryName(existing, '20261006130100', 'x')).toThrow(/jüngsten/);
    expect(() => migrationDirectoryName(existing, '2026100617', 'x')).toThrow(/YYYYMMDDHHMMSS/);
    expect(() => migrationDirectoryName(existing, '20261006170000', 'Bad-Name')).toThrow(
      /snake_case/,
    );
  });

  it('findet Migrationen mit Gerüst-Platzhaltern', () => {
    const root = mkdtempSync(join(tmpdir(), 'tt-sql-migrations-'));
    try {
      for (const [name, sql] of [
        ['20260101000000_done', '-- X.\nBEGIN;\nCOMMIT;\n'],
        ['20260102000000_open', `-- ${MIGRATION_TODO_MARKER}: beschreiben.\nBEGIN;\nCOMMIT;\n`],
      ] as const) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, 'migration.sql'), sql);
      }
      writeFileSync(join(root, 'migration_lock.toml'), MIGRATION_TODO_MARKER);
      expect(findUnfinishedMigrations(root)).toEqual(['20260102000000_open']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Kanonische SQL-Quellen im CI', () => {
  it('prüft im blockierenden db-Job nach Migration, Ledger und Invarianten vor den DB-Tests', () => {
    const db = workflow.jobs['db']!;
    expect(db.if).toBeUndefined();
    expect(db['continue-on-error']).toBeFalsy();
    const gates = db.steps.filter((step) => step.run?.trim() === 'pnpm db:sql:check');
    expect(gates).toHaveLength(1);
    const gate = gates[0]!;
    expect(gate.if).toBeUndefined();
    expect(gate['continue-on-error']).toBeFalsy();
    const index = (run: string) => db.steps.findIndex((step) => step.run?.trim() === run);
    const migrated = index('pnpm db:migrate:deploy');
    const ledger = index('pnpm verify:migration-ledger');
    const invariants = index('pnpm --filter @taxtronik/db verify:invariants');
    const dbTests = db.steps.findIndex((step) =>
      step.run?.includes('pnpm --filter @taxtronik/db test'),
    );
    expect(migrated).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeGreaterThan(migrated);
    expect(invariants).toBe(ledger + 1);
    expect(db.steps.indexOf(gate)).toBe(invariants + 1);
    expect(dbTests).toBeGreaterThan(db.steps.indexOf(gate));
  });

  it('startet die Paketskripte über die Workspace-Wurzel', () => {
    for (const command of ['dump', 'check', 'migration']) {
      expect(rootPackage.scripts[`db:sql:${command}`]).toBe(
        `pnpm --filter @taxtronik/db sql:${command}`,
      );
      expect(dbPackage.scripts[`sql:${command}`]).toBe(
        `tsx --env-file-if-exists=../../.env scripts/sql-sources-cli.ts ${command}`,
      );
    }
  });
});

describe('Eingecheckte kanonische SQL-Quellen', () => {
  const sources = readRepositorySources(SQL_ROOT);
  const paths = [...sources.keys()];

  it('enthalten alle drei Arten, normalisiert und ohne Namenskollisionen', () => {
    for (const kind of ['functions/', 'triggers/', 'policies/']) {
      expect(paths.filter((path) => path.startsWith(kind)).length).toBeGreaterThan(100);
    }
    expect([...sources].filter(([, content]) => normalizeSql(content) !== content)).toEqual([]);
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort());
  });

  it('lassen sich vollständig für das Migrationsgerüst lesen', () => {
    for (const [path, content] of sources) {
      const reference = objectReference(path, content);
      if (path.startsWith('functions/')) {
        expect(content.startsWith('CREATE OR REPLACE FUNCTION ')).toBe(true);
        expect(path).toMatch(new RegExp(`^functions/${reference.name.replaceAll('.', '\\.')}\\(`));
      } else if (path.startsWith('triggers/')) {
        expect(content).toMatch(/^CREATE (CONSTRAINT )?TRIGGER /);
        expect(path).toBe(`triggers/${reference.table}.${reference.name}.sql`);
      } else {
        expect(content.startsWith('CREATE POLICY ')).toBe(true);
        expect(path).toBe(`policies/${reference.table}.${reference.name}.sql`);
      }
    }
  });

  it('führen keine Funktionen der Extensions pgcrypto, pg_trgm und citext', () => {
    expect(
      paths.filter((path) =>
        /^functions\/public\.(?:digest|crypt|gen_salt|pgp_sym_encrypt|similarity|show_trgm|citext\w*|texticlike)\(/.test(
          path,
        ),
      ),
    ).toEqual([]);
    expect(paths).toContain('functions/app.tax_notice_set_appeal_deadline().sql');
  });
});
