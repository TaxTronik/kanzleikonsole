// =============================================================================
// pnpm verify:schema-drift
//
// Erkennt Drift zwischen `schema.prisma` und dem Stand, den alle Migrationen
// zusammen produzieren würden. Siehe ADR 0012.
//
// Vorgehen:
//   1. Shadow-DB resetten + alle Migrationen via `prisma migrate reset` applien
//   2. `prisma migrate diff --from-config-datasource --to-schema schema.prisma`
//   3. Wenn Output nicht leer → exit 1 mit Diff im Log.
//
// Warum `--from-config-datasource` statt `--from-migrations`?
// Prisma's `--from-migrations` parsed die SQL-Migrationen und baut intern
// einen Datamodel-Zustand auf, der `CREATE EXTENSION` nicht als Teil des
// Schema-States erkennt — dadurch entsteht Phantom-Drift bei den Extensions
// citext/pg_trgm/pgcrypto. Mit `--from-config-datasource` introspectiert
// Prisma die Live-DB (in unserem Fall die frisch migrierte Shadow-DB,
// DATABASE_URL = SHADOW_DATABASE_URL) und erkennt die Extensions korrekt.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const schemaFile = join(pkgRoot, 'prisma', 'schema.prisma');

console.log('[verify:schema-drift] Prüfe schema.prisma gegen Migrationen ...');

const shadowUrl = process.env['SHADOW_DATABASE_URL'];
if (!shadowUrl) {
  console.error(
    '[verify:schema-drift] SHADOW_DATABASE_URL nicht gesetzt.\n' +
      '\n' +
      'Der Drift-Check benötigt eine leere Postgres-DB, in die Prisma alle\n' +
      'Migrationen testweise applied. In Production-CI:\n' +
      '  - Service-Postgres im CI-Job hochziehen\n' +
      '  - SHADOW_DATABASE_URL=postgres://...:.../taxtronik_shadow exportieren\n' +
      '\n' +
      'Lokal (über docker-compose ist `postgres` bereits da):\n' +
      '  docker exec taxtronik-postgres psql -U taxtronik -d postgres -c "CREATE DATABASE taxtronik_shadow"\n' +
      '  SHADOW_DATABASE_URL=postgresql://taxtronik:<pwd>@localhost:5432/taxtronik_shadow pnpm verify:schema-drift\n',
  );
  process.exit(1);
}

// 1. Shadow-DB resetten + Migrationen applien.
// migrate deploy ist non-destructive, aber wir wollen einen sauberen Stand —
// also vorher resetten. `migrate reset --force` dropt das Schema und
// re-applied alle Migrationen. Prisma 7 hat --skip-seed/--skip-generate
// entfernt; das Seed-Opt-out läuft jetzt darüber, dass prisma.config.ts den
// seed-Eintrag nur setzt, wenn PRISMA_DRIFT_CHECK ≠ '1' ist.
function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): boolean {
  const result = spawnSync(cmd, args, {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  return result.status === 0;
}

console.log('[verify:schema-drift] Resette Shadow-DB + applye Migrationen ...');
if (
  !run('npx', ['prisma', 'migrate', 'reset', '--force'], {
    DATABASE_URL: shadowUrl,
    PRISMA_DRIFT_CHECK: '1',
  })
) {
  console.error('[verify:schema-drift] migrate reset auf Shadow-DB fehlgeschlagen.');
  process.exit(1);
}

// 2. Diff von der frisch migrierten Shadow-DB zum aktuellen schema.prisma.
// Prisma 7: --from-schema-datasource ist weg, stattdessen
// --from-config-datasource (ohne Pfad, liest die Datasource aus
// prisma.config.ts — DATABASE_URL injizieren wir per Env).
// --to-schema-datamodel wurde zu --to-schema.
console.log('[verify:schema-drift] Berechne Diff Shadow-DB → schema.prisma ...');
const diffResult = spawnSync(
  'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    schemaFile,
    '--exit-code',
  ],
  {
    cwd: pkgRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    encoding: 'utf-8',
    env: { ...process.env, DATABASE_URL: shadowUrl, PRISMA_DRIFT_CHECK: '1' },
  },
);

const stdout = (diffResult.stdout ?? '').trim();
const stderr = (diffResult.stderr ?? '').trim();

if (diffResult.status === 0) {
  console.log('[verify:schema-drift] OK — kein Drift erkannt.');
  process.exit(0);
}

if (diffResult.status === 2) {
  console.error('[verify:schema-drift] DRIFT erkannt:\n');
  console.error(stdout || '(kein Diff-Output — Prisma-CLI hat exit=2 gemeldet)');
  console.error(
    '\nUrsachen:\n' +
      '  - schema.prisma wurde geändert, aber `prisma migrate dev` wurde nicht ausgeführt\n' +
      '  - Eine Hand-SQL-Migration modifiziert Tabellen, die schema.prisma nicht kennt\n' +
      '  - Zwei parallele PRs haben widersprüchliche Migrationen erzeugt\n' +
      '\nNächste Schritte:\n' +
      '  pnpm --filter @taxtronik/db migrate:dev   # generiert die fehlende Migration\n' +
      '  → Migration prüfen, anpassen, committen\n',
  );
  process.exit(1);
}

console.error('[verify:schema-drift] Prisma-CLI-Fehler:');
if (stdout) console.error('stdout:', stdout);
if (stderr) console.error('stderr:', stderr);
process.exit(diffResult.status ?? 1);
