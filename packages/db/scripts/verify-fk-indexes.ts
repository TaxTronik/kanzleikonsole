// =============================================================================
// pnpm verify:fk-indexes
//
// Gate „FK ohne führenden Index“ (Review-Finding D-05), läuft im db-Job neben
// verify:rls gegen die frisch migrierte Datenbank. Regel und Allowlist stehen in
// fk-index-coverage.ts. Exit 1: neuer FK ohne Index oder verwaister
// Allowlist-Eintrag; Exit 2: Verbindungs-/SQL-Fehler.
// =============================================================================

import { PrismaClient } from '../src/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../src/prisma-adapter';
import {
  FOREIGN_KEYS_SQL,
  INDEXES_SQL,
  checkForeignKeyIndexes,
  foreignKeyId,
  type ForeignKeyInfo,
  type IndexInfo,
} from './fk-index-coverage';

async function main() {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('[verify:fk-indexes] DATABASE_URL nicht gesetzt (migrierte Datenbank nötig).');
    process.exit(2);
  }
  const prisma = new PrismaClient({ adapter: createPostgresAdapter(optionalDatabaseUrl(dbUrl)) });
  try {
    const foreignKeys = await prisma.$queryRawUnsafe<ForeignKeyInfo[]>(FOREIGN_KEYS_SQL);
    const indexes = await prisma.$queryRawUnsafe<IndexInfo[]>(INDEXES_SQL);
    const report = checkForeignKeyIndexes(foreignKeys, indexes);

    if (report.violations.length > 0 || report.stale.length > 0) {
      if (report.violations.length > 0) {
        console.error('\n[verify:fk-indexes] ❌ Fremdschlüssel ohne führenden Index:\n');
        for (const fk of report.violations) {
          console.error(`  ${foreignKeyId(fk)} -> ${fk.references} (${fk.constraint})`);
        }
        console.error(
          '\nIndex ergänzen (Spalten des FK vorn, tenant_id davor erlaubt) oder — nur für\n' +
            'Akteur-/Personenverweise — begründet in fk-index-coverage.ts aufnehmen.\n',
        );
      }
      if (report.stale.length > 0) {
        console.error(
          '[verify:fk-indexes] ❌ Allowlist-Einträge ohne ungedeckten FK (entfernen):\n',
        );
        for (const id of report.stale) console.error(`  ${id}`);
      }
      process.exit(1);
    }
    console.log(
      `[verify:fk-indexes] ✅ ${report.checked} Fremdschlüssel geprüft, ` +
        `${report.allowlisted} begründet ohne Index (Allowlist).`,
    );
    process.exit(0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[verify:fk-indexes] Unerwarteter Fehler:', err);
  process.exit(2);
});
