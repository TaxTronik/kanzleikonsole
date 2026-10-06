// Fachkatalog: GWG-ACTIVATION-GATE-001
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// Fachkatalog: GWG-SELF-ONBOARDING-001
//
// Die versionierten GwG-Invarianten (packages/db/invariants/gwg) entscheiden
// nach jeder Kundenmigration, ob schreibende Dienste starten. Dieser Test
// fuehrt genau diese Dateien gegen die echte, migrierte Datenbank aus: Sie
// muessen gelten, eine gezielte Schutzluecke in einer zurueckgerollten
// Transaktion muss genau die zugehoerige Invariante verletzen, der CLI-Pruefer
// meldet SQL-Fehler mit Exit 2, und der Host-Pfad aus scripts/ops-lib.sh liest
// die echte psql-Ausgabe korrekt. Fixtures sind nicht noetig: Es wird nur der
// Katalog gelesen, jede Aenderung wird zurueckgerollt.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const invariantsDir = join(repositoryRoot, 'packages/db/invariants/gwg');
const checker = join(repositoryRoot, 'packages/db/scripts/check-db-invariants.mjs');
const opsLib = join(repositoryRoot, 'scripts/ops-lib.sh');
// ops-lib.sh laedt die Domaenendateien der Operator-CLI aus scripts/ops/.
const opsDir = join(repositoryRoot, 'scripts/ops');
const invariantFiles = readdirSync(invariantsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('DB-Invarianten-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

// Der Host-Pfad braucht bash und psql wie der Deploy (dort im Container).
const hasHostTools =
  process.platform !== 'win32' &&
  spawnSync('bash', ['-c', 'command -v psql'], { encoding: 'utf8' }).status === 0;
if (process.env['CI'] === 'true' && hasDatabase && !hasHostTools) {
  throw new Error('DB-Invarianten-Test braucht bash und psql in CI (Host-Pfad von ops-lib.sh).');
}
const describeHostPath = hasDatabase && hasHostTools ? describe : describe.skip;

describe('Versionierte GwG-Invarianten', () => {
  it('sind genau die drei Pruefungen des Deploy-Gates', () => {
    expect(invariantFiles).toEqual([
      '034-fail-closed-and-destruction.sql',
      '043-identity-subjects-and-document-sets.sql',
      '044-legacy-guard-recovery.sql',
    ]);
    const opsSources = [
      opsLib,
      ...readdirSync(opsDir)
        .filter((name) => name.endsWith('.sh'))
        .map((name) => join(opsDir, name)),
    ];
    const opsLibSource = opsSources.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const file of invariantFiles) expect(opsLibSource).toContain(`="${file}"`);
  });
});

describeWithDatabase('Versionierte GwG-Invarianten gegen die migrierte Datenbank', () => {
  const owner = new Client({ connectionString: process.env['DATABASE_URL'] });

  beforeAll(async () => {
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
  });

  async function violations(): Promise<string[]> {
    const names: string[] = [];
    for (const file of invariantFiles) {
      const result = await owner.query<{ invariant: string }>(
        readFileSync(join(invariantsDir, file), 'utf8'),
      );
      expect(result.fields.map((field) => field.name)).toEqual(['invariant']);
      names.push(...result.rows.map((row) => row.invariant));
    }
    return names.sort();
  }

  async function violationsAfter(sabotage: string): Promise<string[]> {
    await owner.query('BEGIN');
    try {
      await owner.query(sabotage);
      return await violations();
    } finally {
      await owner.query('ROLLBACK');
    }
  }

  it('gelten vollstaendig auf der migrierten Datenbank', async () => {
    expect(await violations()).toEqual([]);
  });

  it.each([
    [
      '034: Hard-Delete-Sperre fuer GwG-Pruefungen fehlt',
      'DROP TRIGGER gwg_check_no_hard_delete ON public.gwg_check',
      'gwg_034.trigger:gwg_check.gwg_check_no_hard_delete',
    ],
    [
      '034: Fail-closed-Deaktivierung ist abgeschaltet',
      'ALTER TABLE public.gwg_check DISABLE TRIGGER gwg_check_fail_closed_client',
      'gwg_034.trigger:gwg_check.gwg_check_fail_closed_client',
    ],
    [
      '034: Vernichtung laeuft nicht mehr als SECURITY DEFINER',
      'ALTER FUNCTION app.destroy_gwg_document_versions(uuid) SECURITY INVOKER',
      'gwg_034.function:app.destroy_gwg_document_versions(uuid)',
    ],
    [
      '034: PUBLIC darf vernichten',
      'GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(uuid) TO PUBLIC',
      'gwg_034.public_execute:app.destroy_gwg_check(uuid)',
    ],
    [
      '034: App-Rolle darf Dokumentversionen direkt loeschen',
      'GRANT DELETE ON public.document_version TO taxtronik_app',
      'gwg_034.app_no_delete:document_version',
    ],
    [
      '043: Vertreter-RLS wird nicht mehr erzwungen',
      'ALTER TABLE public.gwg_representative NO FORCE ROW LEVEL SECURITY',
      'gwg_043.forced_rls:gwg_representative',
    ],
    [
      '043: NOT VALID-Constraint schuetzt den Bestand nicht',
      `ALTER TABLE public.gwg_representative
         DROP CONSTRAINT gwg_representative_position_nonnegative;
       ALTER TABLE public.gwg_representative
         ADD CONSTRAINT gwg_representative_position_nonnegative CHECK (position >= 0) NOT VALID`,
      'gwg_043.constraint:gwg_representative.gwg_representative_position_nonnegative',
    ],
    [
      '043: Dokumentsatz-Konsistenz greift nicht mehr am Transaktionsende',
      `DROP TRIGGER gwg_document_set_consistency ON public.gwg_id_document;
       CREATE CONSTRAINT TRIGGER gwg_document_set_consistency
         AFTER INSERT OR UPDATE ON public.gwg_id_document NOT DEFERRABLE
         FOR EACH ROW EXECUTE FUNCTION app.enforce_gwg_document_set_consistency()`,
      'gwg_043.deferred_constraint_trigger:gwg_id_document.gwg_document_set_consistency',
    ],
    [
      '044: Neufassung des Versionsschutzes ohne Dokumentsperre',
      `DO $sabotage$
       DECLARE definition TEXT;
       BEGIN
         definition := pg_get_functiondef(
           'app.block_version_during_gwg_destruction()'::regprocedure
         );
         EXECUTE replace(definition, 'FOR UPDATE', '');
       END $sabotage$`,
      'gwg_044.function_body:app.block_version_during_gwg_destruction().document_row_lock',
    ],
  ])('%s verletzt genau diese Invariante', async (_label, sabotage, expected) => {
    expect(await violationsAfter(sabotage)).toEqual([expected]);
  });

  it('wertet ein fehlendes Schutzobjekt nie als erfuellt', async () => {
    // Ohne Tabelle liefern die Rechte- und Triggerpruefungen NULL; das muss
    // als Verletzung zaehlen, nicht als "keine Zeile".
    expect(
      await violationsAfter('ALTER TABLE public.document_version RENAME TO document_version_moved'),
    ).toEqual([
      'gwg_034.app_no_delete:document_version',
      'gwg_034.trigger:document_version.document_version_block_gwg_destruction',
      'gwg_044.trigger:document_version.document_version_block_gwg_destruction',
    ]);
  });

  it('bleibt nach den zurueckgerollten Eingriffen erfuellt', async () => {
    expect(await violations()).toEqual([]);
  });
});

describeWithDatabase('CLI-Pruefer check-db-invariants.mjs', () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'db-invariants-'));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function check(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [checker, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  function invariantDirectory(name: string, sql: string): string {
    const directory = join(scratch, name);
    mkdirSync(directory);
    writeFileSync(join(directory, `${name}.sql`), sql);
    return directory;
  }

  it('beendet sich mit 0, wenn alle versionierten Invarianten gelten', () => {
    const result = check([]);
    expect(result.status, result.stderr).toBe(0);
    for (const file of invariantFiles) expect(result.stdout).toContain(`OK invariants/gwg/${file}`);
  });

  it('beendet sich mit 1 und nennt die verletzte Invariante', () => {
    const result = check([
      invariantDirectory('violated', "SELECT 'test.always_violated'::text AS invariant;\n"),
    ]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('- test.always_violated');
  });

  it.each([
    ['einen SQL-Fehler', 'broken', 'SELECT invariant FROM gwg_no_such_relation;\n', '[42P01]'],
    [
      'mehrere Statements',
      'multi',
      "SELECT 'a'::text AS invariant;\nSELECT 'b'::text AS invariant;\n",
      'cannot insert multiple commands',
    ],
    [
      'einen Schreibversuch',
      'write',
      'CREATE TEMP TABLE invariant_write_probe (x INT);\n',
      '[25006]',
    ],
    ['eine falsche Ergebnisspalte', 'shape', 'SELECT 1 AS wrong;\n', 'Spalte "invariant"'],
    ['eine Verletzung ohne Namen', 'unnamed', "SELECT ''::text AS invariant;\n", 'ohne Namen'],
  ])('meldet %s mit Exit 2 statt als erfuellt', (_label, name, sql, message) => {
    const result = check([invariantDirectory(name, sql)]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain('Alle Invarianten erfuellt');
  });

  it('meldet ein Verzeichnis ohne Invariantendateien mit Exit 2', () => {
    const empty = join(scratch, 'empty');
    mkdirSync(empty);
    const result = check([empty]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('Keine Invariantendateien gefunden');
  });

  it('meldet Exit 2, wenn neben einer Verletzung eine Datei nicht pruefbar ist', () => {
    const result = check([
      invariantDirectory('mixed-violated', "SELECT 'test.always_violated'::text AS invariant;\n"),
      invariantDirectory('mixed-broken', 'SELECT invariant FROM gwg_no_such_relation;\n'),
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('- test.always_violated');
    expect(result.stderr).toContain('SQL-/Verbindungsfehler');
  });

  it('meldet einen Verbindungsfehler mit Exit 2', () => {
    const url = new URL(process.env['DATABASE_URL']!);
    url.pathname = `/taxtronik_invariants_missing_${process.pid}`;
    const result = check([], { DATABASE_URL: url.toString() });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('SQL-/Verbindungsfehler beim Verbinden');
  });
});

describeHostPath('ops-lib.sh-Hostpfad gegen die echte Datenbank', () => {
  let scratch: string;
  // Ersetzt wird nur `docker compose exec postgres`: psql-Aufruf, Datei und
  // Auswertung sind die des Deploys.
  const script = `
    set -euo pipefail
    source "$OPS_LIB"
    ROOT="$INVARIANT_ROOT"
    compose() {
      [[ "$1 $2 $3" == "--infra exec -T" ]] || return 97
      shift 3
      local env_args=() args=()
      while [[ "$1" == -e ]]; do env_args+=("$2"); shift 2; done
      [[ "$1 $2" == "postgres psql" ]] || return 98
      shift 2
      while (( $# )); do
        case "$1" in -U|-d) shift 2 ;; *) args+=("$1"); shift ;; esac
      done
      env "\${env_args[@]}" psql -d "$INVARIANT_PSQL_URL" "\${args[@]}"
    }
    status=0
    database_has_gwg_invariants_for_checkout || status=$?
    printf 'status=%s\\n' "$status"
  `;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ops-invariants-'));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  // Checkout-Nachbildung: alle Migrationen, Invariantendateien optional ersetzt.
  function checkout(name: string, replacements: Record<string, string> = {}): string {
    const root = join(scratch, name);
    mkdirSync(join(root, 'packages/db/prisma'), { recursive: true });
    mkdirSync(join(root, 'packages/db/invariants/gwg'), { recursive: true });
    symlinkSync(
      join(repositoryRoot, 'packages/db/prisma/migrations'),
      join(root, 'packages/db/prisma/migrations'),
    );
    for (const file of invariantFiles) {
      const target = join(root, 'packages/db/invariants/gwg', file);
      const replacement = replacements[file];
      if (replacement === undefined) copyFileSync(join(invariantsDir, file), target);
      else writeFileSync(target, replacement);
    }
    return root;
  }

  function runOpsCheck(root: string) {
    // libpq lehnt Prismas ?schema=public ab.
    const url = new URL(process.env['DATABASE_URL']!);
    url.search = '';
    return spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OPS_LIB: opsLib,
        INVARIANT_ROOT: root,
        INVARIANT_PSQL_URL: url.toString(),
      },
    });
  }

  it('gibt 0 zurueck, wenn die versionierten Invarianten gelten', () => {
    const result = runOpsCheck(checkout('holds'));
    expect(result.stdout, result.stderr).toContain('status=0');
    expect(result.stdout + result.stderr).not.toContain('GwG-Invariante');
  });

  it('gibt 1 zurueck und nennt die Verletzung aus der echten psql-Ausgabe', () => {
    const result = runOpsCheck(
      checkout('violated', {
        '043-identity-subjects-and-document-sets.sql':
          "SELECT 'gwg_043.test:violated'::text AS invariant;\n",
      }),
    );
    expect(result.stdout).toContain('status=1');
    expect(result.stdout).toContain(
      'GwG-Invariante verletzt (043-identity-subjects-and-document-sets.sql)',
    );
    expect(result.stderr).toContain('gwg_043.test:violated');
  });

  it('gibt 2 zurueck und meldet den SQL-Fehler, nie als Verletzung', () => {
    const result = runOpsCheck(
      checkout('broken', {
        '034-fail-closed-and-destruction.sql': 'SELECT invariant FROM gwg_no_such_relation;\n',
      }),
    );
    expect(result.stdout).toContain('status=2');
    expect(result.stdout).toContain('SQL-/Verbindungsfehler (Exit 3)');
    expect(result.stderr).toContain('gwg_no_such_relation');
    expect(result.stdout + result.stderr).not.toContain('GwG-Invariante verletzt');
  });

  it('fuehrt die Datei read-only aus', () => {
    const result = runOpsCheck(
      checkout('write', {
        '034-fail-closed-and-destruction.sql': 'CREATE TEMP TABLE invariant_write_probe (x INT);\n',
      }),
    );
    expect(result.stdout).toContain('status=2');
    expect(result.stderr).toContain('read-only transaction');
  });
});
