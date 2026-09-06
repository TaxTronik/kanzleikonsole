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

describe('WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST', () => {
  it('normalisiert fehlend und leer zu einer leeren, deaktivierten Liste', () => {
    const missing = { ...VALID_BASE };
    delete missing.WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST;

    expect(parseEnvFrom(missing).WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST).toEqual([]);
    expect(
      parseEnvFrom({
        ...VALID_BASE,
        WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: '',
      }).WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST,
    ).toEqual([]);
  });

  it('trimmt, kanonisiert und dedupliziert eine komma-separierte Allowlist', () => {
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    expect(
      parseEnvFrom({
        ...VALID_BASE,
        WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: ` ${upper}, ${second}, ${upper} `,
      }).WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST,
    ).toEqual([upper.toLowerCase(), second]);
  });

  it.each(['keine-uuid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,kaputt'])(
    'lehnt den ungültigen Wert %s ab',
    (value) => {
      expect(() =>
        parseEnvFrom({
          ...VALID_BASE,
          WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: value,
        }),
      ).toThrow(/ENV-Validierung/);
    },
  );

  it('begrenzt die Allowlist auf 128 Modellfamilien', () => {
    const tooMany = Array.from(
      { length: 129 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    ).join(',');

    expect(() =>
      parseEnvFrom({
        ...VALID_BASE,
        WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: tooMany,
      }),
    ).toThrow(/ENV-Validierung/);
  });
});

describe('WEBAUTHN_HARDWARE_POLICY_REVISION', () => {
  it('verwendet ohne Konfiguration die initiale Revision 1', () => {
    const source = { ...VALID_BASE };
    delete source.WEBAUTHN_HARDWARE_POLICY_REVISION;

    expect(parseEnvFrom(source).WEBAUTHN_HARDWARE_POLICY_REVISION).toBe(1);
  });

  it('akzeptiert ausschließlich positive ganze Revisionen', () => {
    expect(
      parseEnvFrom({
        ...VALID_BASE,
        WEBAUTHN_HARDWARE_POLICY_REVISION: '7',
      }).WEBAUTHN_HARDWARE_POLICY_REVISION,
    ).toBe(7);

    for (const revision of ['0', '-1', '1.5', 'nicht-ganzzahlig']) {
      expect(() =>
        parseEnvFrom({
          ...VALID_BASE,
          WEBAUTHN_HARDWARE_POLICY_REVISION: revision,
        }),
      ).toThrow(/ENV-Validierung/);
    }
  });
});
