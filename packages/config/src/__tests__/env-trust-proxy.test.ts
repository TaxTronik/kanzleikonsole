// S-03: TRUST_PROXY_HOPS bestimmt, welcher X-Forwarded-For-Eintrag (von rechts)
// als Client-IP gilt. Ungültige Werte dürfen nicht still zu einem anderen Hop
// werden, sonst nähme die App eine vom Client setzbare Adresse.
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

let parseEnvFrom: typeof import('../env').parseEnvFrom;

beforeAll(async () => {
  for (const [key, value] of Object.entries(VALID_BASE)) process.env[key] = value;
  ({ parseEnvFrom } = await import('../env'));
});

describe('TRUST_PROXY_HOPS', () => {
  it('verwendet ohne Konfiguration genau einen Proxy-Hop', () => {
    const missing = { ...VALID_BASE };
    delete missing.TRUST_PROXY_HOPS;
    expect(parseEnvFrom(missing).TRUST_PROXY_HOPS).toBe(1);
    expect(parseEnvFrom({ ...VALID_BASE, TRUST_PROXY_HOPS: '' }).TRUST_PROXY_HOPS).toBe(1);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    ['9', 9],
  ])('übernimmt %s als ganze Zahl', (value, expected) => {
    expect(parseEnvFrom({ ...VALID_BASE, TRUST_PROXY_HOPS: value }).TRUST_PROXY_HOPS).toBe(
      expected,
    );
  });

  it.each(['0', '-1', '10', '1.5', '2 ', ' 2', '0x2', '1e0', 'zwei', 'true'])(
    'lehnt den ungültigen Wert %j ab',
    (value) => {
      expect(() => parseEnvFrom({ ...VALID_BASE, TRUST_PROXY_HOPS: value })).toThrow(
        /ENV-Validierung/,
      );
    },
  );

  it('bleibt unabhängig von TRUST_PROXY_REQUIRED validiert', () => {
    const parsed = parseEnvFrom({
      ...VALID_BASE,
      TRUST_PROXY_REQUIRED: 'true',
      TRUST_PROXY_HOPS: '2',
    });
    expect(parsed.TRUST_PROXY_REQUIRED).toBe(true);
    expect(parsed.TRUST_PROXY_HOPS).toBe(2);
  });
});
