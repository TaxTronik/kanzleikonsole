// =============================================================================
// pnpm secret-box:rewrap — gespeicherte Secret-Box-Werte auf v3 umstellen (S-08)
//
// Stellt alle in SECRET_SLOTS (@taxtronik/crypto) verzeichneten Werte ohne
// Klartextänderung auf das Format v3 mit dem AKTIVEN Schlüssel um (erster
// Eintrag von SECRET_BOX_KEYRING, sonst SECRET_BOX_KEY bzw. AUTH_SECRET).
// Idempotent und wiederaufnehmbar; Ablauf und Voraussetzungen siehe
// docs/operations/secret-rotation.md, Abschnitt „Secret-Box-Schlüssel".
//
//   pnpm secret-box:rewrap               # umstellen
//   pnpm secret-box:rewrap --dry-run     # nur prüfen und zählen
//   pnpm secret-box:rewrap --batch-size=50
//
// Läuft mit der Owner-Verbindung (DATABASE_URL) und derselben .env wie App
// und Worker. Den neuen Schlüsselbund ZUERST in App und Worker ausrollen —
// sonst können diese die umgestellten Werte nicht lesen.
//
// Exit-Code: 0 = vollständig, 1 = nicht entschlüsselbare Werte, 2 = parallel
// geänderte Werte (erneut ausführen).
// =============================================================================

import pg from 'pg';
import {
  activeSecretBoxKeyId,
  configuredSecretBoxKeyIds,
  describeSecretBlob,
  looksEncrypted,
  rewrapSecret,
  SECRET_SLOTS,
  secretSlotContext,
  type SecretContext,
  type SecretSlot,
} from '@taxtronik/crypto';
import { requireDatabaseUrl } from '../src/prisma-adapter';
import {
  rewrapStoredSecrets,
  type RewrapFailure,
  type RewrapSlot,
  type SecretBoxRewrapOps,
} from '../src/secret-box-rewrap';

function fail(message: string): never {
  console.error(`[secret-box:rewrap] FATAL: ${message}`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): { dryRun: boolean; batchSize: number } {
  let dryRun = false;
  let batchSize = 100;
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--batch-size=')) batchSize = Number(arg.slice('--batch-size='.length));
    else fail(`Unbekanntes Argument ${arg} (erlaubt: --dry-run, --batch-size=<n>).`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    fail('--batch-size muss eine ganze Zahl zwischen 1 und 10000 sein.');
  }
  return { dryRun, batchSize };
}

const ops: SecretBoxRewrapOps<SecretContext> = {
  contextFor: (slot: RewrapSlot, ref) => secretSlotContext(slot as SecretSlot, ref),
  looksEncrypted,
  rewrap: rewrapSecret,
  describe: describeSecretBlob,
};

async function main(): Promise<void> {
  const { dryRun, batchSize } = parseArgs(process.argv.slice(2));
  const client = new pg.Client({
    connectionString: requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL'),
  });
  await client.connect();
  const failures: RewrapFailure[] = [];
  try {
    console.log(
      `[secret-box:rewrap] ${dryRun ? 'Prüflauf (--dry-run)' : 'Re-Wrap'} — aktiver Schlüssel ${activeSecretBoxKeyId()}, entschlüsselnd: ${configuredSecretBoxKeyIds().join(', ')}`,
    );
    const report = await rewrapStoredSecrets(
      client,
      Object.entries(SECRET_SLOTS).map(([name, slot]) => ({ name, slot })),
      ops,
      { dryRun, batchSize, onFailure: (failure) => failures.push(failure) },
    );
    for (const stats of report) {
      const before = Object.entries(stats.before)
        .map(([label, count]) => `${label}=${count}`)
        .join(' ');
      console.log(
        `[secret-box:rewrap] ${stats.slot}: gesamt ${stats.total}, aktuell ${stats.current}, ` +
          `${dryRun ? `umzustellen ${stats.pending}` : `umgestellt ${stats.rewrapped}`}, ` +
          `parallel geändert ${stats.concurrent}, fehlerhaft ${stats.failed}, ` +
          `ohne Secret-Box-Format ${stats.notEncrypted}${before ? ` (vorher: ${before})` : ''}`,
      );
    }
    for (const failure of failures) {
      console.error(
        `[secret-box:rewrap] nicht entschlüsselbar: ${failure.slot} tenant=${failure.tenantId}` +
          `${failure.rowId ? ` zeile=${failure.rowId}` : ''}: ${failure.reason}`,
      );
    }
    if (failures.length > 0) {
      process.exitCode = 1;
    } else if (report.some((stats) => stats.concurrent > 0)) {
      console.warn(
        '[secret-box:rewrap] Parallel geänderte Werte übersprungen — bitte erneut ausführen.',
      );
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
