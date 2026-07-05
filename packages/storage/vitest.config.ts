import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests für Aufbewahrungsfristen & Lock-Modus — kein S3-/Netz-Setup.
    pool: 'forks',
    // service.ts importiert transitiv @taxtronik/config, das die ENV beim
    // Modul-Load streng validiert (parseEnv). Für die reinen Fristen-/Lock-
    // Funktionen brauchen wir keinerlei echte Infra, müssen die Validierung aber
    // mit einem minimalen, gültigen DEVELOPMENT-Set befriedigen, damit der Import
    // durchläuft. NODE_ENV=development überspringt die strengen Cross-Field-
    // Production-Checks (siehe packages/config/src/env.ts).
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://owner:pw@localhost:5432/taxtronik',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'a-securely-generated-secret-of-at-least-32-chars',
      NEXTAUTH_URL: 'http://localhost:3000',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'seaweedfs',
      S3_SECRET_KEY: 'seaweedfs12345',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_FROM: 'noreply@taxtronik.local',
    },
  },
});
