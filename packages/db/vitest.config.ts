import { defineConfig } from 'vitest/config';

const requiredDatabaseVariables = ['DATABASE_URL', 'DATABASE_APP_URL'] as const;
const missingDatabaseVariables = requiredDatabaseVariables.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingDatabaseVariables.length > 0) {
  throw new Error(
    `DB-Tests benötigen ${missingDatabaseVariables.join(', ')}. ` +
      'Ohne Owner- und App-Verbindung werden Integrations- und RLS-Tests nicht ausgeführt.',
  );
}

export default defineConfig({
  test: {
    // Alle DB-Tests teilen eine Instanz. Explizite Datei- und Test-Serialisierung
    // schützt auch dann, wenn später test.concurrent hinzukommt.
    pool: 'forks',
    forks: { singleFork: true },
    fileParallelism: false,
    maxConcurrency: 1,
    timeout: 30_000,
  },
});
