import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Single Source of Truth: Root-.env statt packages/db/.env. Verhindert Drift.
loadEnv({ path: resolve(import.meta.dirname, '../../.env'), override: false });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --env-file=../../.env seeds/dev.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
