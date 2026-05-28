// =============================================================================
// Owner-PrismaClient als modul-globaler Singleton (Q2)
//
// Vorher: 8+ Dateien haben jeweils `new PrismaClient(...)` instanziiert. In
// Next.js mit Hot-Reload führt das zu Connection-Pool-Leaks und vielen
// parallelen Pools, weil die Dev-Server-Boundary das Modul neu lädt aber
// die alten Connections nicht schließt.
//
// Lösung: ein einziger Owner-Client pro Modul-Scope, in dev über
// `globalThis` zwischen HMR-Loads geteilt.
//
// `Owner` heißt: BYPASSRLS — direkter DB-Zugriff ohne Tenant-Kontext.
// Für mandantenbezogene Reads/Writes immer `withTenantContext` aus
// @taxtronik/db verwenden.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { createPostgresAdapter, requireDatabaseUrl } from '@taxtronik/db/prisma-adapter';

declare global {
  var __taxtronik_prisma_owner: PrismaClient | undefined;
}

export const prismaOwner: PrismaClient =
  globalThis.__taxtronik_prisma_owner ??
  new PrismaClient({
    adapter: createPostgresAdapter(requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL')),
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__taxtronik_prisma_owner = prismaOwner;
}
