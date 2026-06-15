// =============================================================================
// pnpm verify:rls
//
// RLS-Drift-Gate: Stellt sicher, dass JEDE Tabelle mit Mandantendaten
// Row-Level-Security hat (ENABLE + FORCE + mind. 1 Policy).
//
// RLS ist die letzte harte Sicherheitsgrenze (§203 StGB Mandantentrennung).
// Wenn eine neue Tabelle ohne RLS hinzukommt, ist das ein kritischer Druck-
// durch — App-Level-Filter sind fehleranfällig, RLS nicht.
//
// Siehe ADR 0002 (RLS und App-Level-Tenancy), Security-Review S14 (FORCE RLS).
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../src/prisma-adapter';

// ---------------------------------------------------------------------------
// Allowlist: Tabellen, die bewusst KEIN RLS brauchen.
//
// `_prisma_migrations` — Prisma-Intern, keine Mandantendaten.
// `tax_news_item`       — Globaler BMF/BFH-RSS-Cache, mandanten-übergreifend
//                         (siehe Schema-Kommentar @ TaxNewsItem).
//
// Jeder Eintrag hier muss einen dokumentierten Grund haben. Ohne Grund → RLS.
// ---------------------------------------------------------------------------
const RLS_EXEMPT = new Set<string>([
  '_prisma_migrations',
  'tax_news_item',
]);

interface TableInfo {
  table: string;
  hasTenantId: boolean;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policyCount: number;
}

async function main() {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error(
      '[verify:rls] DATABASE_URL nicht gesetzt.\n' +
        'Der RLS-Check benötigt eine migrierte Datenbank.\n' +
        'In CI wird DATABASE_URL vom postgres-Service bereitgestellt.\n',
    );
    process.exit(2);
  }

  const prisma = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(dbUrl)),
  });

  try {
    const tables = await prisma.$queryRaw<TableInfo[]>`
      SELECT
        c.relname                          AS "table",
        COALESCE(
          (SELECT TRUE FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attname  = 'tenant_id'
             AND NOT a.attisdropped),
          FALSE
        )                                  AS "hasTenantId",
        c.relrowsecurity                   AS "rlsEnabled",
        c.relforcerowsecurity              AS "rlsForced",
        (SELECT count(*)::int FROM pg_policy p
         WHERE p.polrelid = c.oid)         AS "policyCount"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = 'public'
      ORDER BY c.relname;
    `;

    const violations: string[] = [];
    let checked = 0;

    for (const t of tables) {
      if (RLS_EXEMPT.has(t.table)) continue;
      checked++;

      const issues: string[] = [];
      if (!t.rlsEnabled) issues.push('RLS nicht ENABLED');
      if (!t.rlsForced) issues.push('RLS nicht FORCED (Owner kann bypassen)');
      if (t.policyCount === 0) issues.push('keine Policy vorhanden');

      if (issues.length > 0) {
        violations.push(
          `  ❌ ${t.table} (tenant_id=${t.hasTenantId}): ${issues.join(', ')}`,
        );
      }
    }

    if (violations.length > 0) {
      console.error(
        '\n[verify:rls] ❌ RLS-Drift erkannt — folgende Tabellen sind ungeschützt:\n',
      );
      for (const v of violations) console.error(v);
      console.error(
        `\n${violations.length} von ${checked} Tabellen ohne vollständiges RLS.\n` +
          `RLS ist die letzte harte Sicherheitsgrenze (§203 StGB).\n` +
          `Siehe ADR 0002 und Migration iter42_force_rls.\n`,
      );
      process.exit(1);
    }

    const exemptList = [...RLS_EXEMPT].join(', ');
    console.log(
      `[verify:rls] ✅ Alle ${checked} Tabellen haben ENABLE+FORCE RLS + Policy ` +
        `(ausgenommen: ${exemptList}).`,
    );
    process.exit(0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[verify:rls] Unerwarteter Fehler:', err);
  process.exit(2);
});
