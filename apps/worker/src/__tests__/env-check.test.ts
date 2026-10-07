// =============================================================================
// B-05 (a): Konfigurationsprüfung im Worker-Image. Sie prüft web und worker
// mit dem Schema aus @taxtronik/config, meldet jeden Befund als eigene
// doctor-Zeile und endet nur bei Fehlern mit Exit 1 (Warnungen: Exit 0).
// =============================================================================

import { describe, expect, it } from 'vitest';
import { envCheckRow, parseEnvCheckProfiles, runEnvCheck } from '../env-check';

const STARK = 'a-securely-generated-secret-of-at-least-32-chars';

// Wie docker-compose.app.yml den worker-Container befüllt (gekürzt auf das Schema).
const WORKER_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://taxtronik_owner:pw@postgres:5432/taxtronik?schema=public',
  DATABASE_APP_URL: 'postgresql://taxtronik_app:pw@postgres:5432/taxtronik?schema=public',
  DATABASE_DRILL_URL: 'postgresql://taxtronik_drill:pw@postgres:5432/postgres?schema=public',
  REDIS_URL: 'redis://redis:6379',
  AUTH_SECRET: STARK,
  PORTAL_PUBLIC_URL: 'https://mandanten.example.de',
  NEXTAUTH_URL: 'https://kanzlei.example.de',
  S3_ENDPOINT: 'http://seaweedfs:8333',
  S3_ACCESS_KEY: 'prod-access-key',
  S3_SECRET_KEY: 'prod-storage-secret-with-at-least-thirty-two-chars',
  SMTP_HOST: 'smtp.example.de',
  SMTP_PORT: '587',
  SMTP_FROM: 'noreply@example.de',
  N8N_LEGACY_CALLBACKS_ENABLED: 'false',
};

// Wie der app-Container: zusätzlich die Web-Auth-Werte.
const WEB_ENV: NodeJS.ProcessEnv = {
  ...WORKER_ENV,
  NEXTAUTH_TRUST_HOST: 'true',
  TRUST_PROXY_REQUIRED: 'true',
  TRUST_PROXY_HOPS: '1',
  STAFF_COOKIE_DOMAIN: 'kanzlei.example.de',
  PORTAL_COOKIE_DOMAIN: 'mandanten.example.de',
};

function run(args: string[], source: NodeJS.ProcessEnv): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = runEnvCheck(args, source, (line) => lines.push(line));
  return { code, lines };
}

describe('env-check', () => {
  it('prüft ohne Angabe web und worker, sonst genau die genannten Profile', () => {
    expect(parseEnvCheckProfiles([])).toEqual(['web', 'worker']);
    expect(parseEnvCheckProfiles(['--profile', 'worker'])).toEqual(['worker']);
    expect(parseEnvCheckProfiles(['--profile', 'worker', '--profile', 'web'])).toEqual([
      'worker',
      'web',
    ]);
    expect(() => parseEnvCheckProfiles(['--profile', 'cli-storage'])).toThrow('Nutzung');
    expect(() => parseEnvCheckProfiles(['web'])).toThrow('Nutzung');
    expect(() => parseEnvCheckProfiles(['--profile'])).toThrow('Nutzung');
  });

  it('bestätigt eine gültige Produktionskonfiguration mit Exit 0', () => {
    const result = run([], WEB_ENV);

    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      envCheckRow('OK', 'web', 'Schema und Pruefungen der App bestanden'),
      envCheckRow('OK', 'worker', 'Schema und Pruefungen der App bestanden'),
    ]);
  });

  it('meldet alle Fehler eines Profils als FEHLT-Zeilen und endet mit Exit 1', () => {
    const result = run(['--profile', 'web'], {
      ...WEB_ENV,
      AUTH_SECRET: 'zu-kurz',
      NEXTAUTH_URL: 'http://kanzlei.example.de',
      PORTAL_PUBLIC_URL: 'http://mandanten.example.de',
      S3_SECRET_KEY: 'zu-kurz',
    });

    expect(result.code).toBe(1);
    expect(result.lines).toEqual([
      envCheckRow(
        'FEHLT',
        'web',
        '[config] ENV-Validierung: AUTH_SECRET: Secret muss mindestens 32 Zeichen lang sein',
      ),
      envCheckRow('FEHLT', 'web', '[config] NEXTAUTH_URL muss in Produktion HTTPS verwenden.'),
      envCheckRow('FEHLT', 'web', '[config] PORTAL_PUBLIC_URL muss in Produktion HTTPS verwenden.'),
      envCheckRow(
        'FEHLT',
        'web',
        '[config] S3_SECRET_KEY ist in Produktion Pflicht mit mindestens 32 Zeichen.',
      ),
    ]);
  });

  it('meldet Warnungen als WARN-Zeilen, ohne den Exit-Code zu ändern', () => {
    const result = run(['--profile', 'web'], { ...WEB_ENV, PORTAL_COOKIE_DOMAIN: '' });

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(
      /^ {2}WARN {5}SCHEMA_WEB {13}\[config\] WARNUNG: STAFF_COOKIE_DOMAIN\/PORTAL_COOKIE_DOMAIN/,
    );
    expect(result.lines[1]).toBe(
      envCheckRow('OK', 'web', 'Schema und Pruefungen der App bestanden'),
    );
  });

  it('prüft jedes Profil mit seinen eigenen Teilen', () => {
    // Web-Auth-Werte fehlen im worker-Container; nur das Web-Profil verlangt sie.
    const result = run([], { ...WORKER_ENV });

    expect(result.code).toBe(1);
    expect(result.lines).toContain(
      envCheckRow(
        'FEHLT',
        'web',
        '[config] NEXTAUTH_TRUST_HOST muss in Produktion explizit `true` sein. Der Reverse-Proxy muss Host und X-Forwarded-Host auf den kanonischen VHost pinnen — sonst Host-Header-Smuggling möglich (S9).',
      ),
    );
    expect(result.lines).toContain(
      envCheckRow('OK', 'worker', 'Schema und Pruefungen der App bestanden'),
    );
  });

  it('verlangt die Drill-Verbindung nur vom worker-Container (S-01)', () => {
    // Wie docker-compose.app.yml: nur der worker erhält DATABASE_DRILL_URL.
    const app = run(['--profile', 'web'], { ...WEB_ENV, DATABASE_DRILL_URL: undefined });
    const worker = run(['--profile', 'worker'], { ...WORKER_ENV, DATABASE_DRILL_URL: undefined });

    expect(app.code).toBe(0);
    expect(worker.code).toBe(1);
    expect(worker.lines).toEqual([
      envCheckRow(
        'FEHLT',
        'worker',
        '[config] DATABASE_DRILL_URL ist für den Worker in Produktion Pflicht: Der monatliche Restore-Drill legt seine Wegwerf-DB mit der Drill-Rolle taxtronik_drill an (die Owner-Verbindung hat kein CREATEDB).',
      ),
    ]);
  });

  it('verlangt N8N_HMAC_SECRET nur bei Legacy-Callbacks oder Webhook-Basis', () => {
    const ohne = run(['--profile', 'worker'], WORKER_ENV);
    const legacy = run(['--profile', 'worker'], {
      ...WORKER_ENV,
      N8N_LEGACY_CALLBACKS_ENABLED: 'true',
    });

    expect(ohne.code).toBe(0);
    expect(legacy.code).toBe(1);
    expect(legacy.lines[0]).toContain(
      '[config] N8N_HMAC_SECRET ist bei N8N_LEGACY_CALLBACKS_ENABLED',
    );
  });

  it('lehnt einen falschen Aufruf mit Exit 2 ab, ohne zu prüfen', () => {
    const result = run(['--profile', 'n8n'], WEB_ENV);

    expect(result.code).toBe(2);
    expect(result.lines).toEqual([
      '[env-check] Nutzung: env-check.js [--profile web|worker]... (unbekannt: --profile n8n)',
    ]);
  });
});
