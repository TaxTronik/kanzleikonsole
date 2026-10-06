// =============================================================================
// ENV-Profile je Prozess (Review-Befund K-09).
//
// Web, Worker und CLI-Skripte validieren nur die Teile, die sie brauchen. Das
// Web-Profil ist das frühere Gesamtschema (Tests: env-*.test.ts). Hier: die
// Zusammensetzung der Profile, ihre Pflichtwerte, die unveränderte Produktions-
// Härtung in Worker- und CLI-Profilen, der Zugriffsschutz auf profilfremde
// Felder, die Profilwahl und die Lazy-Getter, mit denen Pakete ihre
// Konfiguration erst beim Aufruf lesen.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import devDefaults from '../dev-default-secrets.json';
import {
  ENV_PARTS,
  ENV_PROFILES,
  envProfileKeys,
  envProfileSchema,
  getElsterConfig,
  getRiskLayerConfig,
  parseEnvProfileFrom,
  type EnvPartName,
  type EnvProfileName,
} from '../env-schema';

const STARK = 'a-securely-generated-secret-of-at-least-32-chars';

const WEB_DEV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://owner:pw@localhost:5432/taxtronik',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: STARK,
  NEXTAUTH_URL: 'http://localhost:3000',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'seaweedfs',
  S3_SECRET_KEY: 'seaweedfs12345',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'noreply@taxtronik.local',
};

// Worker ohne NEXTAUTH_URL: Mandanten-Links laufen über PORTAL_PUBLIC_URL.
const WORKER_DEV = mit(WEB_DEV, {
  NEXTAUTH_URL: undefined,
  PORTAL_PUBLIC_URL: 'http://localhost:3001/',
});

const WORKER_PROD = mit(WORKER_DEV, {
  NODE_ENV: 'production',
  DATABASE_APP_URL: 'postgres://app:pw@localhost:5432/taxtronik',
  PORTAL_PUBLIC_URL: 'https://portal.example.de',
  S3_ACCESS_KEY: 'prod-storage-access-key',
  S3_SECRET_KEY: 'prod-storage-secret-with-at-least-thirty-two-chars',
});

const WEB_PROD = mit(WORKER_PROD, {
  NEXTAUTH_URL: 'https://staff.example.de',
  NEXTAUTH_TRUST_HOST: 'true',
  STAFF_COOKIE_DOMAIN: 'staff.example.de',
  PORTAL_COOKIE_DOMAIN: 'portal.example.de',
});

/** Basis plus Änderungen; `undefined` entfernt den Wert. */
function mit(basis: NodeJS.ProcessEnv, aenderung: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ergebnis = { ...basis, ...aenderung };
  for (const [key, value] of Object.entries(aenderung)) {
    if (value === undefined) delete ergebnis[key];
  }
  return ergebnis;
}

function fehler(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function pflichtwerte(profile: EnvProfileName): string[] {
  const shape = envProfileSchema(profile).shape as Record<
    string,
    { safeParse(value: unknown): { success: boolean } }
  >;
  return Object.entries(shape)
    .filter(([, schema]) => !schema.safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe('Zusammensetzung der Profile', () => {
  it('setzt jedes Profil aus seinen Teilen zusammen; das Web-Profil umfasst alle', () => {
    expect(ENV_PROFILES.web).toEqual(Object.keys(ENV_PARTS));
    for (const [profile, parts] of Object.entries(ENV_PROFILES) as Array<
      [EnvProfileName, readonly EnvPartName[]]
    >) {
      // Spätere Teile überschreiben gleichnamige Felder (Web: NEXTAUTH_URL Pflicht).
      const erwartet = new Map<string, unknown>();
      for (const part of parts) {
        for (const [key, schema] of Object.entries(ENV_PARTS[part])) erwartet.set(key, schema);
      }
      const shape = envProfileSchema(profile).shape as Record<string, unknown>;
      expect(Object.keys(shape).sort(), profile).toEqual([...erwartet.keys()].sort());
      for (const [key, schema] of erwartet) expect(shape[key], `${profile}.${key}`).toBe(schema);
      expect([...envProfileKeys(profile)].sort()).toEqual(Object.keys(shape).sort());
    }
  });

  it('verlangt je Prozess nur die Pflichtwerte seiner Teile', () => {
    const basis = ['S3_ACCESS_KEY', 'S3_ENDPOINT', 'S3_SECRET_KEY'];
    const worker = [
      ...basis,
      'AUTH_SECRET',
      'DATABASE_URL',
      'REDIS_URL',
      'SMTP_FROM',
      'SMTP_HOST',
      'SMTP_PORT',
    ].sort();
    expect(pflichtwerte('web')).toEqual([...worker, 'NEXTAUTH_URL'].sort());
    expect(pflichtwerte('worker')).toEqual(worker);
    expect(pflichtwerte('cli-secret-box')).toEqual(['AUTH_SECRET']);
    expect(pflichtwerte('cli-storage')).toEqual(basis);
  });
});

describe('Worker-Profil', () => {
  it('startet ohne Web-Auth-Werte, ELSTER, Lizenz und NEXTAUTH_URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Werte, die nur das Web prüft, sind im Worker bedeutungslos.
    const source = mit(WORKER_PROD, {
      TRUST_PROXY_HOPS: 'kein-hop',
      ELSTER_BRIDGE_URL: 'http://eric-bridge:8085',
      STAFF_COOKIE_DOMAIN: 'example.de',
      PORTAL_COOKIE_DOMAIN: 'example.de',
    });

    const env = parseEnvProfileFrom('worker', source);

    expect(env.PORTAL_PUBLIC_URL).toBe('https://portal.example.de');
    expect(env.NEXTAUTH_URL).toBeUndefined();
    for (const key of ['NEXTAUTH_TRUST_HOST', 'TRUST_PROXY_HOPS', 'ELSTER_BRIDGE_URL']) {
      expect(env).not.toHaveProperty(key);
    }
    // Keine Cookie-Domain-Warnung: die betrifft nur die Web-Oberflächen.
    expect(warn).not.toHaveBeenCalled();
    // Das Web-Profil verlangt die Web-Auth-Werte unverändert.
    expect(
      fehler(() => parseEnvProfileFrom('web', mit(WEB_PROD, { NEXTAUTH_TRUST_HOST: undefined }))),
    ).toMatch(/^\[config\] NEXTAUTH_TRUST_HOST muss in Produktion explizit `true` sein/);
  });

  it('verlangt eine Basis für Mandanten-Links (PORTAL_PUBLIC_URL oder NEXTAUTH_URL)', () => {
    const meldung =
      '[config] PORTAL_PUBLIC_URL oder NEXTAUTH_URL muss gesetzt sein: Basis der Mandanten-Links in versendeten Mails.';
    for (const basis of [WORKER_DEV, WORKER_PROD]) {
      expect(
        fehler(() => parseEnvProfileFrom('worker', mit(basis, { PORTAL_PUBLIC_URL: '' }))),
      ).toBe(meldung);
    }
    expect(
      parseEnvProfileFrom(
        'worker',
        mit(WORKER_PROD, {
          PORTAL_PUBLIC_URL: undefined,
          NEXTAUTH_URL: 'https://kanzlei.example.de',
        }),
      ).NEXTAUTH_URL,
    ).toBe('https://kanzlei.example.de');
  });

  it('härtet Produktion mit denselben Prüfungen und Meldungen wie das Web', () => {
    const faelle: Array<[string, NodeJS.ProcessEnv]> = [
      ['DATABASE_APP_URL fehlt', { DATABASE_APP_URL: undefined }],
      ['AUTH_SECRET ist ein Dev-Default', { AUTH_SECRET: devDefaults.values.AUTH_SECRET[0] }],
      [
        'N8N_ENCRYPTION_KEY (nicht im Schema) ist ein Dev-Default',
        { N8N_ENCRYPTION_KEY: devDefaults.values.N8N_ENCRYPTION_KEY[0] },
      ],
      ['AUTH_SECRET wirkt wie ein Wörterbuchwert', { AUTH_SECRET: `password-${STARK}` }],
      ['S3_SECRET_KEY ist zu kurz', { S3_SECRET_KEY: 'kurz' }],
      ['NEXTAUTH_URL ohne HTTPS', { NEXTAUTH_URL: 'http://staff.example.de' }],
      ['PORTAL_PUBLIC_URL ohne HTTPS', { PORTAL_PUBLIC_URL: 'http://portal.example.de' }],
      ['n8n-Liefermodus test', { N8N_DELIVERY_MODE: 'test' }],
      ['Legacy-Callbacks ohne N8N_HMAC_SECRET', { N8N_LEGACY_CALLBACKS_ENABLED: 'true' }],
      ['RISK_LAYER_URL ohne Token', { RISK_LAYER_URL: 'http://risk-layer:8000' }],
      ['Operator-Secret ohne Basiskonfiguration', { RISK_LAYER_OPERATOR_TOKEN: 'o'.repeat(32) }],
    ];
    for (const [fall, aenderung] of faelle) {
      const worker = fehler(() => parseEnvProfileFrom('worker', mit(WORKER_PROD, aenderung)));
      expect(worker, fall).toMatch(/^\[config\] /);
      expect(worker, fall).toBe(fehler(() => parseEnvProfileFrom('web', mit(WEB_PROD, aenderung))));
    }
  });
});

describe('CLI-Profile', () => {
  it('cli-secret-box braucht nur die Secret-Box-Schlüssel und härtet sie wie bisher', () => {
    const source = { NODE_ENV: 'production', AUTH_SECRET: STARK, SECRET_BOX_KEYRING: '' };
    expect(parseEnvProfileFrom('cli-secret-box', source)).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      AUTH_SECRET: STARK,
      SECRET_BOX_KEYRING: [],
    });
    expect(
      fehler(() =>
        parseEnvProfileFrom('cli-secret-box', {
          ...source,
          AUTH_SECRET: devDefaults.values.AUTH_SECRET[0],
        }),
      ),
    ).toMatch(/^\[config\] AUTH_SECRET ist auf einen bekannten Dev-Default-Wert gesetzt\./);
    expect(
      fehler(() =>
        parseEnvProfileFrom('cli-secret-box', { ...source, AUTH_SECRET: 'x'.repeat(40) }),
      ),
    ).toMatch(/^\[config\] AUTH_SECRET wirkt wie ein Wörterbuch- oder Wiederholungs-Wert/);
  });

  it('cli-storage braucht nur Object-Store und Virenscanner; die Denylist gilt für alle Werte', () => {
    const source = {
      NODE_ENV: 'production',
      S3_ENDPOINT: 'http://localhost:8333',
      S3_ACCESS_KEY: 'prod-storage-access-key',
      S3_SECRET_KEY: 'prod-storage-secret-with-at-least-thirty-two-chars',
    };
    expect(parseEnvProfileFrom('cli-storage', source)).toMatchObject({
      S3_BUCKET_GOBD: 'gobd',
      CLAMAV_HOST: 'localhost',
      CLAMAV_PORT: 3310,
    });
    expect(
      fehler(() => parseEnvProfileFrom('cli-storage', { ...source, S3_SECRET_KEY: 'kurz' })),
    ).toBe('[config] S3_SECRET_KEY ist in Produktion Pflicht mit mindestens 32 Zeichen.');
    // Profilfremde Werte prüft die Denylist roh aus der Prozess-ENV, wie zuvor.
    expect(
      fehler(() =>
        parseEnvProfileFrom('cli-storage', {
          ...source,
          POSTGRES_PASSWORD: devDefaults.values.POSTGRES_PASSWORD[0],
        }),
      ),
    ).toMatch(/^\[config\] POSTGRES_PASSWORD ist auf einen bekannten Dev-Default-Wert gesetzt\./);
  });

  it('meldet Schemafehler nur für die Felder des Profils, im bisherigen Format', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      fehler(() =>
        parseEnvProfileFrom('cli-storage', {
          S3_ACCESS_KEY: 'k',
          S3_SECRET_KEY: 's',
          SMTP_PORT: 'x',
        }),
      ),
    ).toBe('ENV-Validierung fehlgeschlagen — siehe Konsole.');
    expect(error.mock.calls).toEqual([
      [
        '[config] ENV-Validierung fehlgeschlagen:\n  - S3_ENDPOINT: Invalid input: expected string, received undefined',
      ],
    ]);
  });
});

describe('Profilwahl und Zugriffsschutz (./env.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('validiert ohne Wahl das Web-Profil mit allen Feldern', async () => {
    process.env = { ...WEB_DEV };
    const config = await import('../env');
    expect(config.env.NEXTAUTH_URL).toBe('http://localhost:3000');
    expect(config.env.TRUST_PROXY_HOPS).toBe(1);
    expect(config.portalBaseUrl).toBe('http://localhost:3000');
  });

  it('validiert nach Wahl des Worker-Profils nur dessen Teile und sperrt Web-Felder', async () => {
    process.env = {
      ...WORKER_DEV,
      RISK_LAYER_URL: 'http://risk-layer:8000/',
      RISK_LAYER_TOKEN: 'r'.repeat(32),
      ELSTER_BRIDGE_URL: 'http://eric-bridge:8085',
      ELSTER_BRIDGE_TOKEN: 'e'.repeat(16),
    };
    await import('../profiles/worker');
    const config = await import('../env');

    expect(config.env.SMTP_HOST).toBe('localhost');
    expect(config.env.NEXTAUTH_URL).toBeUndefined();
    expect(config.portalBaseUrl).toBe('http://localhost:3001');
    expect(config.riskLayerConfig).toEqual({
      url: 'http://risk-layer:8000',
      token: 'r'.repeat(32),
    });
    expect(config.elsterConfig).toBeNull();
    for (const key of [
      'NEXTAUTH_TRUST_HOST',
      'STAFF_COOKIE_DOMAIN',
      'ELSTER_BRIDGE_URL',
    ] as const) {
      expect(() => config.env[key]).toThrow(
        `[config] ${key} gehört nicht zum ENV-Profil „worker“ dieses Prozesses (packages/config/src/env-schema.ts).`,
      );
    }
  });

  it('CLI-Profil: nur eigene Felder, keine Mandanten-Links', async () => {
    process.env = { NODE_ENV: 'production', AUTH_SECRET: STARK };
    await import('../profiles/cli-secret-box');
    const config = await import('../env');

    expect(config.env.AUTH_SECRET).toBe(STARK);
    expect(config.env.SECRET_BOX_KEYRING).toEqual([]);
    expect(config.portalBaseUrl).toBe('');
    expect(config.riskLayerConfig).toBeNull();
    expect(() => config.env.DATABASE_URL).toThrow(
      /^\[config\] DATABASE_URL gehört nicht zum ENV-Profil „cli-secret-box“/,
    );
  });

  it('verweigert eine andere Profilwahl, nachdem die ENV validiert ist', async () => {
    process.env = { ...WEB_DEV };
    const { selectEnvProfile } = await import('../profile');
    await import('../env');
    expect(() => selectEnvProfile('worker')).toThrow(
      '[config] ENV wurde bereits für das Profil „web“ validiert. Das Profil „worker“ muss vor jedem anderen Import gewählt werden (erster Import des Einstiegsmoduls).',
    );
    expect(() => selectEnvProfile('web')).not.toThrow();
  });
});

describe('Lazy-Getter für Pakete', () => {
  const TOKEN = 't'.repeat(32);
  const OPERATOR = 'o'.repeat(32);

  it('getRiskLayerConfig liest beim Aufruf nur den Risk-Layer-Teil', () => {
    expect(getRiskLayerConfig({})).toBeNull();
    expect(getRiskLayerConfig({ RISK_LAYER_URL: 'http://risk-layer:8000/' })).toBeNull();
    expect(
      getRiskLayerConfig({
        RISK_LAYER_URL: 'http://risk-layer:8000/',
        RISK_LAYER_TOKEN: TOKEN,
        RISK_LAYER_OPERATOR_TOKEN: OPERATOR,
      }),
    ).toEqual({ url: 'http://risk-layer:8000', token: TOKEN, operatorToken: OPERATOR });
    expect(fehler(() => getRiskLayerConfig({ RISK_LAYER_OPERATOR_TOKEN: OPERATOR }))).toMatch(
      /^\[config\] RISK_LAYER_OPERATOR_TOKEN gesetzt, aber die Risk-Layer-Basiskonfiguration/,
    );
    expect(
      fehler(() =>
        getRiskLayerConfig({
          RISK_LAYER_URL: 'http://risk-layer:8000',
          RISK_LAYER_TOKEN: TOKEN,
          RISK_LAYER_OPERATOR_TOKEN: TOKEN,
        }),
      ),
    ).toBe('[config] RISK_LAYER_OPERATOR_TOKEN muss sich von RISK_LAYER_TOKEN unterscheiden.');

    process.env = { RISK_LAYER_URL: 'http://risk-layer:8000', RISK_LAYER_TOKEN: TOKEN };
    expect(getRiskLayerConfig()).toEqual({ url: 'http://risk-layer:8000', token: TOKEN });
  });

  it('getElsterConfig liest beim Aufruf nur den ELSTER-Teil', () => {
    expect(getElsterConfig({ ELSTER_BRIDGE_URL: 'http://eric-bridge:8085/' })).toBeNull();
    process.env = {
      ELSTER_BRIDGE_URL: 'http://eric-bridge:8085/',
      ELSTER_BRIDGE_TOKEN: 'e'.repeat(16),
    };
    expect(getElsterConfig()).toEqual({ url: 'http://eric-bridge:8085', token: 'e'.repeat(16) });

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(fehler(() => getElsterConfig({ ELSTER_BRIDGE_URL: 'kein-url' }))).toBe(
      'ENV-Validierung fehlgeschlagen — siehe Konsole.',
    );
    expect(String(error.mock.calls[0]?.[0])).toContain('  - ELSTER_BRIDGE_URL: ');
  });
});
