// S-08: Schlüsselbund der Secret-Box (SECRET_BOX_KEYRING).
import { beforeAll, describe, expect, it, vi } from 'vitest';

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

const KEY_1 = 'secret-box-data-key-one-with-more-than-32-chars';
const KEY_2 = 'secret-box-data-key-two-with-more-than-32-chars';

let parseEnvFrom: typeof import('../env').parseEnvFrom;

beforeAll(async () => {
  for (const [key, value] of Object.entries(VALID_BASE)) process.env[key] = value;
  ({ parseEnvFrom } = await import('../env'));
});

describe('SECRET_BOX_KEYRING', () => {
  it('fehlend oder leer ergibt einen leeren Schlüsselbund (Wurzel verschlüsselt)', () => {
    expect(parseEnvFrom({ ...VALID_BASE }).SECRET_BOX_KEYRING).toEqual([]);
    expect(parseEnvFrom({ ...VALID_BASE, SECRET_BOX_KEYRING: '' }).SECRET_BOX_KEYRING).toEqual([]);
  });

  it('übernimmt die Einträge getrimmt und in der konfigurierten Reihenfolge', () => {
    expect(
      parseEnvFrom({ ...VALID_BASE, SECRET_BOX_KEYRING: ` ${KEY_2} , ${KEY_1}` })
        .SECRET_BOX_KEYRING,
    ).toEqual([KEY_2, KEY_1]);
  });

  it.each([
    ['zu kurzer Eintrag', `${KEY_1},zu-kurz`],
    ['leerer Eintrag', `${KEY_1},`],
    ['doppelter Eintrag', `${KEY_1},${KEY_1}`],
    ['mehr als acht Einträge', Array.from({ length: 9 }, (_, i) => `${KEY_1}-${i}`).join(',')],
  ])('lehnt %s ab', (_label, value) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => parseEnvFrom({ ...VALID_BASE, SECRET_BOX_KEYRING: value })).toThrow(
        /ENV-Validierung/,
      );
      expect(String(error.mock.calls[0]?.[0])).not.toContain(KEY_1);
    } finally {
      error.mockRestore();
    }
  });
});
