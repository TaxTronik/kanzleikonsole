import { beforeAll, describe, expect, it } from 'vitest';

const VALID_BASE: NodeJS.ProcessEnv = {
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
};

const PROD_BASE: NodeJS.ProcessEnv = {
  ...VALID_BASE,
  NODE_ENV: 'production',
  DATABASE_APP_URL: 'postgres://app:pw@localhost:5432/taxtronik',
  N8N_HMAC_SECRET: 'a-securely-generated-hmac-secret-of-at-least-32-chars',
  NEXTAUTH_URL: 'https://staff.example.de',
  NEXTAUTH_TRUST_HOST: 'true',
  S3_ACCESS_KEY: 'prod-storage-access-key',
  S3_SECRET_KEY: 'prod-storage-secret-with-at-least-thirty-two-chars',
  STAFF_COOKIE_DOMAIN: 'staff.example.de',
  PORTAL_COOKIE_DOMAIN: 'portal.example.de',
};

let parseEnvFrom: typeof import('../env').parseEnvFrom;

beforeAll(async () => {
  for (const [k, v] of Object.entries(VALID_BASE)) {
    process.env[k] = v;
  }
  ({ parseEnvFrom } = await import('../env'));
});

describe('ENV production hardening', () => {
  it('akzeptiert ein hartes production-ENV', () => {
    expect(() => parseEnvFrom(PROD_BASE)).not.toThrow();
  });

  it('verlangt HTTPS fuer NEXTAUTH_URL und PORTAL_PUBLIC_URL', () => {
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, NEXTAUTH_URL: 'http://staff.example.de' }),
    ).toThrow(/NEXTAUTH_URL.*HTTPS/);
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, PORTAL_PUBLIC_URL: 'http://portal.example.de' }),
    ).toThrow(/PORTAL_PUBLIC_URL.*HTTPS/);
  });

  it('blockt bekannte oder kurze S3-Secrets in production', () => {
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, S3_SECRET_KEY: 'seaweedfs12345' }),
    ).toThrow(/S3_SECRET_KEY.*Dev-Default/);
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, S3_SECRET_KEY: 'short-storage-secret' }),
    ).toThrow(/S3_SECRET_KEY/);
  });

  it('erlaubt in production keinen test/log n8n-Liefermodus', () => {
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, N8N_DELIVERY_MODE: 'test' }),
    ).toThrow(/N8N_DELIVERY_MODE/);
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, N8N_DELIVERY_MODE: 'log' }),
    ).toThrow(/N8N_DELIVERY_MODE/);
  });

  it('verlangt Risk-Layer-URL und Token als Paar', () => {
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, RISK_LAYER_URL: 'https://risk-layer.internal' }),
    ).toThrow(/RISK_LAYER_TOKEN/);
    expect(() =>
      parseEnvFrom({
        ...PROD_BASE,
        RISK_LAYER_TOKEN: 'risk-layer-token-with-at-least-thirty-two-chars',
      }),
    ).toThrow(/RISK_LAYER_URL/);
  });

  it('blockt Parent-Domain-Cookie-Scope', () => {
    expect(() =>
      parseEnvFrom({ ...PROD_BASE, STAFF_COOKIE_DOMAIN: '.example.de' }),
    ).toThrow(/Parent-Domain/);
  });
});
