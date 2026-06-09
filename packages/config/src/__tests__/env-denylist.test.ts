// =============================================================================
// Unit-Test: ENV-Validierung — Dev-Default-Denylist & Cross-Field-Constraints.
//
// Audit Round 14, Finding 7: bekannte Dev-Secrets dürfen in production
// niemals durchschlüpfen. Dieser Test garantiert, dass:
//   - AUTH_SECRET-Default aus dem Repo-Template abgelehnt wird
//   - „passwortmanager-ähnliche" Wiederholungs-/Wörterbuch-Werte abgelehnt werden
//   - schwache Defaults für N8N_HMAC_SECRET in production blockieren
//   - NEXTAUTH_TRUST_HOST in production explizit sein muss
//   - DATABASE_APP_URL in production Pflicht ist (RLS-Backstop)
//
// Die Tests rufen `parseEnvFrom` mit einem kontrollierten Pseudo-ENV.
// Dynamischer Import, damit die initiale Modul-Load-Validierung mit
// einem gültigen Set durchläuft.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';

const VALID_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://owner:pw@localhost:5432/taxtronik',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a-securely-generated-secret-of-at-least-32-chars',
  NEXTAUTH_URL: 'http://localhost:3000',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'noreply@taxtronik.local',
};

const PROD_BASE: NodeJS.ProcessEnv = {
  ...VALID_BASE,
  NODE_ENV: 'production',
  DATABASE_APP_URL: 'postgres://app:pw@localhost:5432/taxtronik',
  N8N_HMAC_SECRET: 'a-securely-generated-hmac-secret-of-at-least-32-chars',
  NEXTAUTH_TRUST_HOST: 'true',
  STAFF_COOKIE_DOMAIN: 'staff.example.de',
  PORTAL_COOKIE_DOMAIN: 'portal.example.de',
};

// Dynamischer Import: Vitest startet das Test-File in einem Fork, der
// initiale Modul-Load-`parseEnv()`-Aufruf braucht VALID_BASE-Werte.
let parseEnvFrom: typeof import('../env').parseEnvFrom;

beforeAll(async () => {
  // Pre-load: setze process.env, dann lade das Modul.
  for (const [k, v] of Object.entries(VALID_BASE)) {
    process.env[k] = v;
  }
  ({ parseEnvFrom } = await import('../env'));
});

describe('ENV — Dev-Default-Denylist (Audit Round 14, Finding 7)', () => {
  it('akzeptiert valides production-ENV', () => {
    expect(() => parseEnvFrom(PROD_BASE)).not.toThrow();
  });

  it('akzeptiert valides development-ENV ohne strenge Cross-Field-Checks', () => {
    expect(() => parseEnvFrom(VALID_BASE)).not.toThrow();
  });

  it('lehnt AUTH_SECRET = Repo-Default in production ab', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        AUTH_SECRET: 'taxtronik-dev-auth-secret-change-in-production-please',
      }),
    ).toThrow(/AUTH_SECRET.*Dev-Default/);
  });

  it('lehnt N8N_HMAC_SECRET = bekannten Dev-Default in production ab', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        N8N_HMAC_SECRET: 'dev-only-hmac-secret-min-32-chars-long-xxx',
      }),
    ).toThrow(/N8N_HMAC_SECRET.*Dev-Default/);
  });

  it('lehnt AUTH_SECRET mit Wörterbuch-Präfix ab (password…)', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        AUTH_SECRET: 'password1234password1234password1234',
      }),
    ).toThrow(/Wörterbuch|Wiederholungs/);
  });

  it('lehnt AUTH_SECRET mit Wiederholungs-Muster ab', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        AUTH_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow(/Wörterbuch|Wiederholungs/);
  });

  it('lehnt zu kurzes AUTH_SECRET ab (Zod min 32)', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        AUTH_SECRET: 'too-short',
      }),
    ).toThrow();
  });

  it('production OHNE DATABASE_APP_URL → throw (RLS-Backstop-Pflicht)', () => {
    const broken = { ...PROD_BASE };
    delete broken.DATABASE_APP_URL;
    expect(() => parseEnvFrom(broken)).toThrow(/DATABASE_APP_URL/);
  });

  it('production OHNE N8N_HMAC_SECRET → throw', () => {
    const broken = { ...PROD_BASE };
    delete broken.N8N_HMAC_SECRET;
    expect(() => parseEnvFrom(broken)).toThrow(/N8N_HMAC_SECRET/);
  });

  it('production MIT zu kurzem N8N_HMAC_SECRET → throw', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        N8N_HMAC_SECRET: 'short',
      }),
    ).toThrow(/N8N_HMAC_SECRET/);
  });

  it('production OHNE NEXTAUTH_TRUST_HOST → throw (Host-Header-Smuggling-Schutz)', () => {
    const broken = { ...PROD_BASE };
    delete broken.NEXTAUTH_TRUST_HOST;
    expect(() => parseEnvFrom(broken)).toThrow(/NEXTAUTH_TRUST_HOST/);
  });

  it('production mit gleichen Staff-/Portal-Cookie-Domains → throw (S12)', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        STAFF_COOKIE_DOMAIN: 'kanzlei.example.de',
        PORTAL_COOKIE_DOMAIN: 'kanzlei.example.de',
      }),
    ).toThrow(/STAFF_COOKIE_DOMAIN.*PORTAL_COOKIE_DOMAIN/);
  });

  it('production ohne Cookie-Domains warnt, schmeißt aber nicht', () => {
    // Single-Host-Deploy ist erlaubt (Warnung im Log, kein Fail).
    const noDomains = { ...PROD_BASE };
    delete noDomains.STAFF_COOKIE_DOMAIN;
    delete noDomains.PORTAL_COOKIE_DOMAIN;
    expect(() => parseEnvFrom(noDomains)).not.toThrow();
  });

  it('production mit invalid DATABASE_URL-Scheme → throw (Zod-Refinement)', () => {
    // Zod-Issues werden in env.ts auf der Konsole geloggt und der Throw selbst
    // ist eine generische Sammelmeldung — wir prüfen also nur, dass es
    // überhaupt schmeißt. Field-Detail siehe console.error.
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        DATABASE_URL: 'mysql://owner:pw@localhost:3306/taxtronik',
      }),
    ).toThrow(/ENV-Validierung/);
  });

  it('production mit invalid REDIS_URL-Scheme → throw (Zod-Refinement)', () => {
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        REDIS_URL: 'amqp://localhost:5672',
      }),
    ).toThrow(/ENV-Validierung/);
  });

  it('leeres SMTP_HOST → throw (Fail-fast, analog S3_ACCESS_KEY .min(1))', () => {
    expect(() =>
      parseEnvFrom({
        ...VALID_BASE,
        SMTP_HOST: '',
      }),
    ).toThrow(/ENV-Validierung/);
  });

  it('leeres SMTP_FROM → throw (Fail-fast, analog S3_ACCESS_KEY .min(1))', () => {
    expect(() =>
      parseEnvFrom({
        ...VALID_BASE,
        SMTP_FROM: '',
      }),
    ).toThrow(/ENV-Validierung/);
  });
});
