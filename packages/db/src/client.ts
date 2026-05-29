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
  // Fail-closed RLS-Backstop: In Produktion MUSS die App über DATABASE_APP_URL
  // (eingeschränkte Role, RLS greift) verbinden. Der Owner `taxtronik` hat
  // BYPASSRLS — ein stiller Fallback auf DATABASE_URL würde die komplette
  // Mandantentrennung aushebeln (§ 203 StGB). @taxtronik/config validiert das
  // zwar beim Boot, aber client.ts liest process.env direkt und darf sich
  // nicht auf die Import-Reihenfolge verlassen. Daher hier nochmal hart.
  if (process.env['NODE_ENV'] === 'production' && !process.env['DATABASE_APP_URL']) {
    throw new Error(
      '[db] DATABASE_APP_URL ist in Produktion Pflicht. Kein Fallback auf die ' +
        'Owner-Verbindung (BYPASSRLS) — das würde die RLS-Mandantentrennung aushebeln.',
    );
  }
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
