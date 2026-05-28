// =============================================================================
// Prisma-Client als Singleton.
//
// Nutzt DATABASE_APP_URL (eingeschränkte Role mit RLS) wenn gesetzt,
// sonst DATABASE_URL (Owner). In Produktion immer DATABASE_APP_URL.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from './prisma-adapter';

declare global {
  var __taxtronikPrisma: PrismaClient | undefined;
}

function buildClient(): PrismaClient {
  const datasourceUrl = process.env['DATABASE_APP_URL'] ?? process.env['DATABASE_URL'];

  return new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(datasourceUrl)),
    log:
      process.env['NODE_ENV'] === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
  });
}

// Hot-Reload-sicherer Singleton in Dev.
export const prisma: PrismaClient = globalThis.__taxtronikPrisma ?? buildClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__taxtronikPrisma = prisma;
}

export type { PrismaClient } from '@prisma/client';
