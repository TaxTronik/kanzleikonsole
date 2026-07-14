import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Single Source of Truth: Root-.env statt packages/db/.env. Verhindert Drift.
loadEnv({ path: resolve(import.meta.dirname, '../../.env'), override: false });

// Der Drift-Check ruft `prisma migrate reset` auf der Shadow-DB auf und will
// dabei NICHT seeden. Prisma 7 hat --skip-seed entfernt; das Opt-out läuft
// jetzt darüber, die seed-Config gar nicht erst zu setzen. PRISMA_DRIFT_CHECK
// wird in scripts/verify-drift.ts gesetzt.
const skipSeed = process.env['PRISMA_DRIFT_CHECK'] === '1';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    ...(skipSeed ? {} : { seed: 'tsx --env-file-if-exists=../../.env seeds/dev.ts' }),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
