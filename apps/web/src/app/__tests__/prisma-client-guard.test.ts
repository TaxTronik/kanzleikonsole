// =============================================================================
// DB-Guard: jede PrismaClient-Instanz im Monorepo ist bewusst freigegeben
//
// Hintergrund (Security-Review, § 203 StGB): Der App-Request-Pfad MUSS über
// den RLS-gefilterten App-Client (packages/db client.ts → resolveAppDatasourceUrl
// → withTenantContext) laufen. Ein frei im Code instanziierter `new PrismaClient`
// kann versehentlich die Owner-Verbindung (BYPASSRLS) nutzen oder den
// Tenant-Kontext-Wrapper umgehen — beides hebelt die Mandantentrennung aus.
//
// Dieser Test scannt apps/ und packages/ nach `new PrismaClient` und vergleicht
// die Treffer mit einer Allowlist bewusst freigegebener Stellen. Taucht eine
// NEUE Datei auf, schlägt der Test an und zwingt zur Entscheidung:
//   - Owner-/System-Client (Migration, Worker-Job, Backup, Seed, Test)?
//     → mit Begründung in ALLOWED_PRISMA_CLIENT_FILES eintragen.
//   - App-Request-Pfad? → KEIN eigener Client. prisma + withTenantContext
//     aus @taxtronik/db verwenden.
// =============================================================================

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../../');
const SCAN_DIRS = ['apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.turbo', 'dist', 'build', 'out', 'coverage', '.git',
]);
const NEEDLE = 'new PrismaClient';
// Dieser Guard erwähnt NEEDLE in Kommentaren/Meldungen, instanziiert aber
// keinen Client — sich selbst nicht als Treffer werten.
const SELF = 'apps/web/src/app/__tests__/prisma-client-guard.test.ts';

// Bewusst freigegebene Stellen (repo-relativ, Forward-Slashes). Jede ist KEIN
// App-Request-Pfad-Client.
const ALLOWED_PRISMA_CLIENT_FILES = new Set<string>([
  // Der App-Client selbst — fail-closed via resolveAppDatasourceUrl.
  'packages/db/src/client.ts',
  // Owner-Verbindung (BYPASSRLS) ausschließlich für Migrationen/Verifikation.
  'packages/db/src/owner-client.ts',
  // Dev-Seed (NODE_ENV!=production erzwungen), Owner-Verbindung.
  'packages/db/seeds/dev.ts',
  // RLS-Integrationstest konstruiert bewusst Owner- + App-Client.
  'packages/db/src/__tests__/rls-cross-tenant.test.ts',
  // Owner-Singleton für System-/Worker-Jobs (laufen via withSystemContext).
  'apps/web/src/server/db/prisma-owner.ts',
  'apps/worker/src/prisma-owner.ts',
  // Backup-Restore-Probe — Admin-Operation gegen die Ziel-DB.
  'apps/web/src/server/backup/restore.ts',
]);

function walk(dir: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(resolve(dir, entry.name), acc);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      acc.push(resolve(dir, entry.name));
    }
  }
}

describe('PrismaClient-Guard — keine ungeprüften DB-Clients', () => {
  it('jede `new PrismaClient`-Stelle steht auf der Allowlist', () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(resolve(REPO_ROOT, d), files);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (!content.includes(NEEDLE)) continue;
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      if (rel === SELF) continue;
      if (!ALLOWED_PRISMA_CLIENT_FILES.has(rel)) offenders.push(rel);
    }

    expect(
      offenders,
      `Neue \`new PrismaClient\`-Instanz(en) gefunden:\n  ${offenders.join('\n  ')}\n\n` +
        'App-Request-Pfad? → KEIN eigener Client, sondern prisma + withTenantContext ' +
        'aus @taxtronik/db. Owner-/System-Client? → mit Begründung in ' +
        'ALLOWED_PRISMA_CLIENT_FILES eintragen.',
    ).toEqual([]);
  });

  it('Allowlist ist nicht verwaist (jede Datei existiert noch und nutzt PrismaClient)', () => {
    const stale: string[] = [];
    for (const rel of ALLOWED_PRISMA_CLIENT_FILES) {
      try {
        const content = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
        if (!content.includes(NEEDLE)) stale.push(rel);
      } catch {
        stale.push(rel);
      }
    }
    expect(
      stale,
      `Allowlist-Einträge ohne \`new PrismaClient\` (umbenannt/gelöscht?) — bitte ` +
        `aus ALLOWED_PRISMA_CLIENT_FILES entfernen:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
