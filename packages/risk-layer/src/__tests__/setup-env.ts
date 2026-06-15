// =============================================================================
// Vitest-Setup: minimale, gültige ENV bereitstellen.
//
// @taxtronik/config validiert die gesamte ENV beim Modul-Import (fail-fast).
// Da der RiskLayerClient (über config.ts) transitiv @taxtronik/config lädt,
// braucht schon der bloße Import eine valide ENV. setupFiles laufen vor den
// Test-Modulen — hier setzen wir die Pflichtfelder, sofern nicht ohnehin via
// echter .env vorhanden. RISK_LAYER_* bleiben bewusst ungesetzt (riskLayerConfig
// === null); die Client-Tests injizieren ihre Config direkt.
// =============================================================================

const DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
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
};

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}
