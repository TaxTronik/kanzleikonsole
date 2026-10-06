// =============================================================================
// Prisma-Owner-Client (T-1).
//
// Zweiter Prisma-Client, der IMMER `DATABASE_URL` (Owner-Rolle mit BYPASSRLS)
// verwendet. Begründung:
//  - Login-Flow läuft VOR dem Tenant-Context (`current_setting('app.…') = NULL`)
//    → die App-Rolle würde nichts sehen. Auth muss Owner sein.
//  - CLI-Tools (z. B. `pnpm verify:chain`) iterieren über alle Tenants. Mit der
//    App-Rolle würde `tenant.findMany()` ein leeres Array liefern, weil
//    `tenant_self_read` nur `id = current_tenant_id()` zulässt — der CLI
//    schlösse stillschweigend „grün" ab, ohne je einen Audit-Eintrag geprüft
//    zu haben. Compliance-blocker.
//
// Diese Datei spiegelt das Pattern aus apps/web/src/server/db/prisma-owner.ts,
// damit auch Package-interne Tools (CLI) den Owner-Client ohne web-Import
// nutzen können.
//
// S-01 (ADR 0002): In den Containern app und worker ist `DATABASE_URL` die
// Rolle `taxtronik_owner` — BYPASSRLS, aber kein Superuser. Sie darf nur
// Daten lesen und schreiben (Grants aus Migration 20261006160000); DDL,
// TRUNCATE, Rollen, Trigger-Abschaltung und Änderungen an audit_log/
// audit_seal/audit_anchor scheitern. Was ein Owner-Pfad darüber hinaus
// braucht, gehört als gezielter Grant oder SECURITY-DEFINER-Funktion in eine
// Migration (Rechtetest: __tests__/owner-role-privileges.test.ts). Nur
// Host-Werkzeuge der Operator-CLI verbinden über diese Variable als Superuser.
// =============================================================================

import { PrismaClient as PrismaClientCtor, type PrismaClientInstance } from './prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from './prisma-adapter';

type PrismaClient = PrismaClientInstance;

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronikPrismaOwner: PrismaClient | undefined;
}

function buildOwnerClient(): PrismaClient {
  return new PrismaClientCtor({
    adapter: createPostgresAdapter(
      requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL'),
      {},
      'owner',
    ),
    log: ['warn', 'error'],
  });
}

export const prismaOwner: PrismaClient = globalThis.__taxtronikPrismaOwner ?? buildOwnerClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__taxtronikPrismaOwner = prismaOwner;
}
