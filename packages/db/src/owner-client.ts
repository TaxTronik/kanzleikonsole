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
// =============================================================================

import prismaClientPkg from '@prisma/client';
const { PrismaClient } = prismaClientPkg;
type PrismaClient = InstanceType<typeof prismaClientPkg.PrismaClient>;
import { createPostgresAdapter, requireDatabaseUrl } from './prisma-adapter';

declare global {
  var __taxtronikPrismaOwner: PrismaClient | undefined;
}

function buildOwnerClient(): PrismaClient {
  return new PrismaClient({
    adapter: createPostgresAdapter(requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL')),
    log: ['warn', 'error'],
  });
}

export const prismaOwner: PrismaClient =
  globalThis.__taxtronikPrismaOwner ?? buildOwnerClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__taxtronikPrismaOwner = prismaOwner;
}
