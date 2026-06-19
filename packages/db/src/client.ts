// =============================================================================
// Prisma-Client als Singleton.
//
// Nutzt DATABASE_APP_URL (eingeschränkte Role mit RLS) wenn gesetzt,
// sonst DATABASE_URL (Owner). In Produktion immer DATABASE_APP_URL.
// =============================================================================

import { PrismaClient as PrismaClientCtor, type PrismaClientInstance } from './prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from './prisma-adapter';

export type PrismaClient = PrismaClientInstance;

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronikPrisma: PrismaClient | undefined;
}

/** Minimaler ENV-Ausschnitt, den die Datasource-Auswahl braucht. */
export interface AppDatasourceEnv {
  NODE_ENV?: string | undefined;
  DATABASE_APP_URL?: string | undefined;
  DATABASE_URL?: string | undefined;
}

/**
 * Wählt die Datasource-URL für den App-Prisma-Client (Request-Pfad).
 *
 * Fail-closed RLS-Backstop: In Produktion MUSS die App über DATABASE_APP_URL
 * (eingeschränkte Role, RLS greift) verbinden. Der Owner `taxtronik` hat
 * BYPASSRLS — ein stiller Fallback auf DATABASE_URL würde die komplette
 * Mandantentrennung aushebeln (§ 203 StGB). @taxtronik/config validiert das
 * zwar beim Boot, aber client.ts liest process.env direkt und darf sich nicht
 * auf die Import-Reihenfolge verlassen — daher hier nochmal hart und als reine,
 * testbare Funktion (siehe client-fail-closed.test.ts).
 */
export function resolveAppDatasourceUrl(env: AppDatasourceEnv): string | undefined {
  if (env.NODE_ENV === 'production' && !env.DATABASE_APP_URL) {
    throw new Error(
      '[db] DATABASE_APP_URL ist in Produktion Pflicht. Kein Fallback auf die ' +
        'Owner-Verbindung (BYPASSRLS) — das würde die RLS-Mandantentrennung aushebeln.',
    );
  }
  return env.DATABASE_APP_URL ?? env.DATABASE_URL;
}

function buildClient(): PrismaClient {
  const datasourceUrl = resolveAppDatasourceUrl(process.env);

  return new PrismaClientCtor({
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
