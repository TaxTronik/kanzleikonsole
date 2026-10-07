// =============================================================================
// B-05: checkEnvProfileFrom sammelt alle Befunde einer Profilprüfung, statt beim
// ersten Fehler abzubrechen. Das Urteil muss dabei exakt dem Boot-Gate
// (parseEnvProfileFrom) entsprechen; nur die Zahl der gemeldeten Befunde steigt.
// Grundlage der Konfigurationsprüfung im Ziel-Image vor Backup und Migration.
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEnvProfileFrom, parseEnvProfileFrom, type EnvProfileName } from '../env-schema';

const STARK = 'a-securely-generated-secret-of-at-least-32-chars';

const WORKER_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://owner:pw@localhost:5432/taxtronik',
  DATABASE_APP_URL: 'postgres://app:pw@localhost:5432/taxtronik',
  DATABASE_DRILL_URL: 'postgres://drill:pw@localhost:5432/postgres',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: STARK,
  PORTAL_PUBLIC_URL: 'https://portal.example.de',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'prod-storage-access-key',
  S3_SECRET_KEY: 'prod-storage-secret-with-at-least-thirty-two-chars',
  SMTP_HOST: 'smtp.example.de',
  SMTP_PORT: '587',
  SMTP_FROM: 'noreply@example.de',
};

const WEB_PROD: NodeJS.ProcessEnv = {
  ...WORKER_PROD,
  NEXTAUTH_URL: 'https://staff.example.de',
  NEXTAUTH_TRUST_HOST: 'true',
  STAFF_COOKIE_DOMAIN: 'staff.example.de',
  PORTAL_COOKIE_DOMAIN: 'portal.example.de',
};

/** Basis plus Änderungen; `undefined` entfernt den Wert. */
function mit(basis: NodeJS.ProcessEnv, aenderung: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ergebnis = { ...basis, ...aenderung };
  for (const [key, value] of Object.entries(aenderung)) {
    if (value === undefined) delete ergebnis[key];
  }
  return ergebnis;
}

function bootVerdict(profile: EnvProfileName, source: NodeJS.ProcessEnv): 'ok' | 'fehler' {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    parseEnvProfileFrom(profile, source);
    return 'ok';
  } catch {
    return 'fehler';
  }
}

afterEach(() => vi.restoreAllMocks());

// Je ein Fall pro Prüfung und Schemafeld-Art, für beide Profile.
const FAELLE: Array<[string, NodeJS.ProcessEnv]> = [
  ['gültige Produktion', {}],
  ['AUTH_SECRET zu kurz', { AUTH_SECRET: 'kurz' }],
  ['AUTH_SECRET Wiederholungsmuster', { AUTH_SECRET: 'password1234password1234password1234' }],
  ['SECRET_BOX_KEY zu kurz', { SECRET_BOX_KEY: 'kurz' }],
  ['S3_SECRET_KEY zu kurz', { S3_SECRET_KEY: 'kurz' }],
  ['N8N_HMAC_SECRET zu kurz', { N8N_HMAC_SECRET: 'kurz' }],
  ['Legacy-Callbacks ohne HMAC', { N8N_LEGACY_CALLBACKS_ENABLED: 'true' }],
  ['NEXTAUTH_URL ohne HTTPS', { NEXTAUTH_URL: 'http://staff.example.de' }],
  ['PORTAL_PUBLIC_URL ohne HTTPS', { PORTAL_PUBLIC_URL: 'http://portal.example.de' }],
  ['NEXTAUTH_TRUST_HOST fehlt', { NEXTAUTH_TRUST_HOST: undefined }],
  ['TRUST_PROXY_HOPS ungültig', { TRUST_PROXY_HOPS: '0' }],
  ['SMTP_PORT keine Zahl', { SMTP_PORT: 'abc' }],
  ['Risk-Layer ohne Token', { RISK_LAYER_URL: 'http://risk-layer:8000' }],
  [
    'Risk-Layer-Operator-Token zu kurz',
    {
      RISK_LAYER_URL: 'http://risk-layer:8000',
      RISK_LAYER_TOKEN: STARK,
      RISK_LAYER_OPERATOR_TOKEN: 'kurz',
    },
  ],
  [
    'Risk-Layer-Tokens identisch',
    {
      RISK_LAYER_URL: 'http://risk-layer:8000',
      RISK_LAYER_TOKEN: STARK,
      RISK_LAYER_OPERATOR_TOKEN: STARK,
    },
  ],
  ['Cookie-Domain einseitig', { PORTAL_COOKIE_DOMAIN: undefined }],
  ['Cookie-Domains gleich', { PORTAL_COOKIE_DOMAIN: 'staff.example.de' }],
  ['DATABASE_APP_URL fehlt', { DATABASE_APP_URL: undefined }],
  ['DATABASE_DRILL_URL fehlt', { DATABASE_DRILL_URL: undefined }],
  ['DATABASE_DRILL_URL leer', { DATABASE_DRILL_URL: '' }],
  ['DATABASE_DRILL_URL kein PostgreSQL', { DATABASE_DRILL_URL: 'mysql://drill:pw@localhost/x' }],
  ['N8N_DELIVERY_MODE test', { N8N_DELIVERY_MODE: 'test' }],
];

describe('checkEnvProfileFrom', () => {
  for (const profile of ['web', 'worker'] as const) {
    const basis = profile === 'web' ? WEB_PROD : WORKER_PROD;
    it.each(FAELLE)(`${profile}: gleiches Urteil wie das Boot-Gate – %s`, (_name, aenderung) => {
      const source = mit(basis, aenderung);
      const findings = checkEnvProfileFrom(profile, source);
      expect(findings.errors.length === 0 ? 'ok' : 'fehler').toBe(bootVerdict(profile, source));
    });
  }

  it('meldet jede fehlgeschlagene Prüfung einzeln, nicht nur die erste', () => {
    const findings = checkEnvProfileFrom(
      'web',
      mit(WEB_PROD, {
        N8N_HMAC_SECRET: 'kurz',
        NEXTAUTH_URL: 'http://staff.example.de',
        PORTAL_PUBLIC_URL: 'http://portal.example.de',
        RISK_LAYER_TOKEN: STARK,
      }),
    );

    expect(findings.errors).toEqual([
      '[config] N8N_HMAC_SECRET muss in Produktion mindestens 32 Zeichen lang sein.',
      '[config] NEXTAUTH_URL muss in Produktion HTTPS verwenden.',
      '[config] PORTAL_PUBLIC_URL muss in Produktion HTTPS verwenden.',
      '[config] RISK_LAYER_TOKEN gesetzt, aber RISK_LAYER_URL fehlt.',
    ]);
    expect(findings.warnings).toEqual([]);
  });

  it('meldet Schemafehler je Feld und prüft die gültigen Felder trotzdem weiter', () => {
    const findings = checkEnvProfileFrom(
      'web',
      mit(WEB_PROD, {
        AUTH_SECRET: 'kurz',
        SMTP_PORT: 'abc',
        NEXTAUTH_URL: 'http://staff.example.de',
      }),
    );

    expect(findings.errors).toContain(
      '[config] ENV-Validierung: AUTH_SECRET: Secret muss mindestens 32 Zeichen lang sein',
    );
    expect(findings.errors.some((m) => m.startsWith('[config] ENV-Validierung: SMTP_PORT: '))).toBe(
      true,
    );
    expect(findings.errors).toContain('[config] NEXTAUTH_URL muss in Produktion HTTPS verwenden.');
  });

  it('liefert Warnungen getrennt, ohne das Urteil zu ändern; das Boot-Gate warnt weiter über die Konsole', () => {
    const source = mit(WEB_PROD, { STAFF_COOKIE_DOMAIN: undefined });
    const findings = checkEnvProfileFrom('web', source);

    expect(findings.errors).toEqual([]);
    expect(findings.warnings).toHaveLength(1);
    expect(findings.warnings[0]).toMatch(
      /^\[config\] WARNUNG: STAFF_COOKIE_DOMAIN\/PORTAL_COOKIE_DOMAIN/,
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    parseEnvProfileFrom('web', source);
    expect(warn).toHaveBeenCalledWith(findings.warnings[0]);
  });

  it('verlangt DATABASE_DRILL_URL in Produktion nur vom Worker, der den Restore-Drill ausführt', () => {
    const ohneDrill = { DATABASE_DRILL_URL: undefined };
    expect(checkEnvProfileFrom('worker', mit(WORKER_PROD, ohneDrill)).errors).toEqual([
      '[config] DATABASE_DRILL_URL ist für den Worker in Produktion Pflicht: Der monatliche Restore-Drill legt seine Wegwerf-DB mit der Drill-Rolle taxtronik_drill an (die Owner-Verbindung hat kein CREATEDB).',
    ]);
    // Der app-Container erhält die Drill-Verbindung bewusst nicht.
    expect(checkEnvProfileFrom('web', mit(WEB_PROD, ohneDrill)).errors).toEqual([]);
    expect(
      checkEnvProfileFrom('worker', mit(WORKER_PROD, { ...ohneDrill, NODE_ENV: 'development' }))
        .errors,
    ).toEqual([]);
    const ungueltig = checkEnvProfileFrom(
      'worker',
      mit(WORKER_PROD, { DATABASE_DRILL_URL: 'mysql://drill:pw@localhost/x' }),
    ).errors;
    expect(ungueltig[0]).toMatch(/^\[config\] ENV-Validierung: DATABASE_DRILL_URL: /);
  });

  it('prüft außerhalb von Produktion nur die immer geltenden Regeln', () => {
    const findings = checkEnvProfileFrom(
      'worker',
      mit(WORKER_PROD, {
        NODE_ENV: 'development',
        S3_SECRET_KEY: 'kurz',
        PORTAL_PUBLIC_URL: undefined,
      }),
    );

    expect(findings.errors).toEqual([
      '[config] PORTAL_PUBLIC_URL oder NEXTAUTH_URL muss gesetzt sein: Basis der Mandanten-Links in versendeten Mails.',
    ]);
  });
});
