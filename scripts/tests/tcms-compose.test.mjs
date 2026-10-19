// TCMS Stufe 2: Compose-Profil `tcms` (infra/compose/docker-compose.tcms.yml).
//
// Sicherheitsregeln, die hier maschinell gelten:
// - Netztrennung: tcms-backend nur tcms-db/tcms-migrate/tcms-api, tcms-frontend
//   nur tcms-api/app/worker, beide internal, keine Host-Ports.
// - Haertung wie die uebrigen Dienste (read_only, no-new-privileges, cap_drop,
//   tmpfs, Logging, mem_limit), Nicht-root fuer tcms-db und tcms-api.
// - Images: tcms-db per Digest, tcms-api/tcms-migrate nie implizit gezogen.
// - Geringste Rechte in der Umgebung: tcms-api ohne Superuser-/Owner-Passwort
//   und ohne privaten Schluessel, app/worker ohne TCMS-Datenbankzugang.
// - Pflichtwerte brechen Compose nur ab, wenn die TCMS-Datei geladen ist.
//
// Der statische Teil liest die Dateien direkt. Der dynamische Teil prueft das
// tatsaechliche Compose-Modell (`docker compose config`); er braucht nur den
// Docker-Client, keinen Daemon. Fehlt der Client, wird er lokal
// uebersprungen; in CI (CI=true, wie der Runner es setzt) oder mit
// TAXTRONIK_REQUIRE_DOCKER_COMPOSE=1 ist er Pflicht und scheitert dann.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = join(ROOT, 'infra/compose/docker-compose.yml');
const APP = join(ROOT, 'infra/compose/docker-compose.app.yml');
const TCMS = join(ROOT, 'infra/compose/docker-compose.tcms.yml');
const TCMS_SERVICES = ['tcms-db', 'tcms-migrate', 'tcms-api'];
const BACKEND = ['tcms-api', 'tcms-db', 'tcms-migrate'];
const FRONTEND = ['app', 'tcms-api', 'worker'];

const load = (file) => yaml.load(readFileSync(file, 'utf8'));

// Wegwerfwerte; jeder Wert ist eindeutig, damit Lecks in fremde Dienste
// am Wert erkennbar sind.
const BASE_ENV = {
  POSTGRES_PASSWORD: 'wegwerf-pg-superuser',
  TAXTRONIK_APP_PASSWORD: 'wegwerf-kk-app',
  TAXTRONIK_OWNER_PASSWORD: 'wegwerf-kk-owner',
  TAXTRONIK_DRILL_PASSWORD: 'wegwerf-kk-drill',
  AUTH_SECRET: 'wegwerf-auth-secret',
  NEXTAUTH_TRUST_HOST: 'true',
  TRUST_PROXY_REQUIRED: 'false',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_FROM: 'noreply@example.test',
  S3_ACCESS_KEY: 'wegwerfak',
  S3_SECRET_KEY: 'wegwerfsk',
  N8N_ENCRYPTION_KEY: 'wegwerf-n8n-key',
  N8N_DB_PASSWORD: 'wegwerf-n8n-db',
};
const SECRET = {
  super: 'wegwerf-tcms-superuser-pw',
  owner: 'wegwerf-tcms-owner-pw',
  app: 'wegwerf-tcms-app-pw',
  tokens: 'wegwerfTokenAlt0123456789abcdefghijk,wegwerfTokenNeu0123456789abcdefghijk',
  token: 'wegwerfTokenNeu0123456789abcdefghijk',
  // Form-Attrappe (PKCS#8-Praefix plus Fuelltext), zur Laufzeit zusammengesetzt,
  // damit der Secret-Scan kein Schluesselliteral meldet.
  privateKey: ['MC4CAQAwBQYDK2VwBCIEI', 'wegwerfPrivatSchluessel0123456789abcdefghijk'].join(''),
};
const TCMS_ENV = {
  TCMS_DEPLOYMENT: 'managed',
  TCMS_URL: 'http://tcms-api:3200',
  TCMS_SERVICE_TOKEN: SECRET.token,
  TCMS_ACTOR_PRIVATE_KEY: SECRET.privateKey,
  TCMS_ACTOR_KEY_ID: 'kk-test-neu',
  TCMS_SERVICE_TOKENS: SECRET.tokens,
  TCMS_ACTOR_PUBLIC_KEYS: 'kk-test-neu=MCowBQYDK2VwAyEAwegwerfOeffentlich0123456789abcdefghijkA=',
  TCMS_DB_SUPERUSER_PASSWORD: SECRET.super,
  TCMS_DB_OWNER_PASSWORD: SECRET.owner,
  TCMS_DB_APP_PASSWORD: SECRET.app,
  TCMS_VERSION: '1.2.3',
  TCMS_API_DIGEST_SUFFIX: `@sha256:${'1'.repeat(64)}`,
  TCMS_MIGRATE_DIGEST_SUFFIX: `@sha256:${'2'.repeat(64)}`,
};

// ---------------------------------------------------------------------------
// Statisch: Rohdateien
// ---------------------------------------------------------------------------

test('TCMS-Dienste, -Netze und -Pflichtwerte stehen nur in der TCMS-Datei', () => {
  for (const file of [BASE, APP]) {
    const doc = load(file);
    for (const name of TCMS_SERVICES) {
      assert.equal(doc.services[name], undefined, `${file}: ${name}`);
    }
    assert.equal(doc.networks?.['tcms-backend'], undefined, file);
    assert.equal(doc.networks?.['tcms-frontend'], undefined, file);
    const text = readFileSync(file, 'utf8');
    // In der immer geladenen Datei duerfen TCMS-Werte Compose nie abbrechen.
    assert.doesNotMatch(text, /\$\{TCMS_[A-Z_]+:\?/, file);
    assert.doesNotMatch(
      text,
      /TCMS_DB_[A-Z_]*PASSWORD|TCMS_SERVICE_TOKENS|TCMS_ACTOR_PUBLIC_KEYS/,
      file,
    );
  }
});

test('Rohdatei: Netze intern, Mitgliedschaften getrennt, keine Ports', () => {
  const doc = load(TCMS);
  assert.equal(doc.networks['tcms-backend'].internal, true);
  assert.equal(doc.networks['tcms-frontend'].internal, true);
  const members = (network) =>
    Object.entries(doc.services)
      .filter(([, service]) => {
        const nets = service.networks ?? [];
        return Array.isArray(nets) ? nets.includes(network) : Object.hasOwn(nets, network);
      })
      .map(([name]) => name)
      .sort();
  assert.deepEqual(members('tcms-backend'), BACKEND);
  assert.deepEqual(members('tcms-frontend'), FRONTEND);
  for (const name of ['app', 'worker']) {
    assert.ok(Object.hasOwn(doc.services[name].networks, 'default'), `${name} behaelt default`);
  }
  for (const name of TCMS_SERVICES) {
    assert.equal(doc.services[name].ports, undefined, `${name} veroeffentlicht keinen Port`);
    assert.equal(doc.services[name].network_mode, undefined, name);
  }
});

// ---------------------------------------------------------------------------
// Dynamisch: tatsaechliches Compose-Modell
// ---------------------------------------------------------------------------

const composeAvailable =
  spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const requireCompose =
  process.env.TAXTRONIK_REQUIRE_DOCKER_COMPOSE === '1' || process.env.CI === 'true';
const dynamic = {
  skip: composeAvailable || requireCompose ? false : 'docker compose fehlt (in CI Pflicht)',
};

function envFile(values) {
  const dir = mkdtempSync(join(tmpdir(), 'tcms-compose-'));
  const file = join(dir, 'test.env');
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  return file;
}

function composeConfig(files, values, { profile = true } = {}) {
  const args = ['compose', ...files.flatMap((file) => ['-f', file]), '--env-file', envFile(values)];
  if (profile) args.push('--profile', 'tcms');
  args.push('config', '--format', 'json');
  // Hermetisch: keine geerbten TCMS-/Compose-Werte aus der Shell des Testlaufs.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('TCMS_') && !key.startsWith('COMPOSE_') && !(key in BASE_ENV),
    ),
  );
  return spawnSync('docker', args, { encoding: 'utf8', env });
}

function managedModel(values = { ...BASE_ENV, ...TCMS_ENV }) {
  const result = composeConfig([BASE, APP, TCMS], values);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const networksOf = (service) => Object.keys(service.networks ?? { default: null }).sort();

test(
  'ohne TCMS-Datei: keine TCMS-Dienste, App nur im Standardnetz, keine Pflichtwerte',
  dynamic,
  () => {
    const result = composeConfig([BASE, APP], BASE_ENV, { profile: false });
    assert.equal(result.status, 0, result.stderr);
    const model = JSON.parse(result.stdout);
    for (const name of TCMS_SERVICES) assert.equal(model.services[name], undefined, name);
    assert.deepEqual(networksOf(model.services.app), ['default']);
    assert.deepEqual(networksOf(model.services.worker), ['default']);
    assert.equal(model.services.app.environment.TCMS_DEPLOYMENT, 'disabled');
  },
);

test('verwaltet: keine App-Dienste im Backend-Netz, beide Netze intern', dynamic, () => {
  const model = managedModel();
  const members = (network) =>
    Object.entries(model.services)
      .filter(([, service]) => networksOf(service).includes(network))
      .map(([name]) => name)
      .sort();
  assert.deepEqual(members('tcms-backend'), BACKEND);
  assert.deepEqual(members('tcms-frontend'), FRONTEND);
  assert.deepEqual(networksOf(model.services['tcms-db']), ['tcms-backend']);
  assert.deepEqual(networksOf(model.services['tcms-migrate']), ['tcms-backend']);
  assert.deepEqual(networksOf(model.services['tcms-api']), ['tcms-backend', 'tcms-frontend']);
  for (const name of ['app', 'worker']) {
    assert.deepEqual(networksOf(model.services[name]), ['default', 'tcms-frontend'], name);
  }
  for (const name of ['postgres', 'redis', 'seaweedfs', 'clamav', 'n8n', 'migrate']) {
    assert.ok(!networksOf(model.services[name]).some((n) => n.startsWith('tcms-')), name);
  }
  assert.equal(model.networks['tcms-backend'].internal, true);
  assert.equal(model.networks['tcms-frontend'].internal, true);
  assert.equal(model.networks['tcms-backend'].name, 'taxtronik-tcms-backend');
  assert.equal(model.networks['tcms-frontend'].name, 'taxtronik-tcms-frontend');
  for (const name of TCMS_SERVICES) {
    assert.equal(model.services[name].ports, undefined, `${name} ohne Host-Port`);
  }
});

test('verwaltet: Haertung, Nicht-root, Healthchecks und Startreihenfolge', dynamic, () => {
  const model = managedModel();
  for (const name of TCMS_SERVICES) {
    const service = model.services[name];
    assert.deepEqual(service.profiles, ['tcms'], name);
    assert.equal(service.read_only, true, `${name} read_only`);
    assert.deepEqual(service.cap_drop, ['ALL'], `${name} cap_drop`);
    assert.equal(service.cap_add, undefined, `${name} ohne cap_add`);
    assert.deepEqual(service.security_opt, ['no-new-privileges:true'], name);
    assert.equal(service.logging?.driver, 'json-file', name);
    assert.equal(service.logging?.options?.['max-size'], '10m', name);
    assert.ok(Number(service.mem_limit) > 0, `${name} mem_limit`);
    assert.ok(
      (service.tmpfs ?? []).some((entry) => entry.startsWith('/tmp:')),
      `${name} tmpfs`,
    );
    assert.equal(service.privileged, undefined, name);
  }
  assert.equal(model.services['tcms-db'].user, '70:70');
  assert.equal(model.services['tcms-api'].user, '10001:10001');
  // tcms-migrate: Nutzer des Images (postgres) und kein anonymes Volume aus dem
  // VOLUME des PostgreSQL-Basisimages.
  assert.equal(model.services['tcms-migrate'].user, '70:70');
  assert.ok(
    (model.services['tcms-migrate'].tmpfs ?? []).some((entry) =>
      entry.startsWith('/var/lib/postgresql:'),
    ),
    'tcms-migrate tmpfs /var/lib/postgresql',
  );
  assert.match(model.services['tcms-db'].image, /^postgres:18-alpine@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(model.services['tcms-db'].healthcheck.test, [
    'CMD-SHELL',
    'pg_isready -U tcms -d tcms',
  ]);
  assert.deepEqual(model.services['tcms-api'].healthcheck.test, [
    'CMD',
    'node',
    '/app/healthcheck.mjs',
  ]);
  assert.equal(model.services['tcms-migrate'].restart, 'no');
  assert.equal(model.services['tcms-migrate'].depends_on['tcms-db'].condition, 'service_healthy');
  assert.equal(model.services['tcms-api'].depends_on['tcms-db'].condition, 'service_healthy');
  assert.equal(
    model.services['tcms-api'].depends_on['tcms-migrate'].condition,
    'service_completed_successfully',
  );
  for (const name of ['tcms-migrate', 'tcms-api']) {
    assert.equal(model.services[name].pull_policy, 'never', `${name} wird nie implizit gezogen`);
  }
  assert.equal(
    model.services['tcms-api'].image,
    `taxtronik/tcms-api:1.2.3@sha256:${'1'.repeat(64)}`,
  );
  assert.equal(
    model.services['tcms-migrate'].image,
    `taxtronik/tcms-migrate:1.2.3@sha256:${'2'.repeat(64)}`,
  );
  // Rollenpasswoerter erscheinen nie im Postgres-Log (Statement-Text bei Fehlern).
  const command = model.services['tcms-db'].command.join(' ');
  assert.match(command, /log_min_error_statement=panic/);
  assert.match(command, /log_error_verbosity=terse/);
});

test('verwaltet: jeder Dienst erhaelt nur seine eigenen Geheimnisse', dynamic, () => {
  const model = managedModel();
  const env = (name) => model.services[name].environment ?? {};
  const values = (name) => Object.values(env(name)).join('\n');

  assert.deepEqual(Object.keys(env('tcms-api')).sort(), [
    'DATABASE_URL',
    'HOST',
    'NODE_ENV',
    'PORT',
    'TCMS_ACTOR_PUBLIC_KEYS',
    'TCMS_LOG_LEVEL',
    'TCMS_SERVICE_TOKENS',
  ]);
  assert.match(env('tcms-api').DATABASE_URL, /^postgresql:\/\/tcms_app:[^@]+@tcms-db:5432\/tcms$/);
  for (const secret of [SECRET.super, SECRET.owner, SECRET.privateKey]) {
    assert.ok(
      !values('tcms-api').includes(secret),
      'tcms-api ohne Superuser/Owner/privaten Schluessel',
    );
  }
  assert.deepEqual(Object.keys(env('tcms-db')).sort(), [
    'POSTGRES_DB',
    'POSTGRES_PASSWORD',
    'POSTGRES_USER',
  ]);
  assert.deepEqual(Object.keys(env('tcms-migrate')).sort(), [
    'TCMS_DB_APP_PASSWORD',
    'TCMS_DB_OWNER_PASSWORD',
    'TCMS_DB_OWNER_URL',
    'TCMS_DB_SUPERUSER_URL',
  ]);
  for (const name of ['app', 'worker']) {
    for (const secret of [SECRET.super, SECRET.owner, SECRET.app, SECRET.tokens]) {
      assert.ok(
        !values(name).includes(secret),
        `${name} ohne TCMS-Datenbankzugang und Token-Liste`,
      );
    }
    assert.equal(env(name).TCMS_SERVICE_TOKEN, SECRET.token, name);
    assert.equal(env(name).TCMS_URL, 'http://tcms-api:3200', name);
  }
  for (const name of Object.keys(model.services)) {
    if (name === 'tcms-db' || name === 'tcms-migrate') continue;
    assert.ok(
      !values(name).includes(SECRET.super),
      `${name} kennt das TCMS-Superuser-Passwort nicht`,
    );
  }
});

test('Pflichtwerte brechen nur ab, wenn die TCMS-Datei geladen ist', dynamic, () => {
  for (const key of [
    'TCMS_DB_SUPERUSER_PASSWORD',
    'TCMS_DB_OWNER_PASSWORD',
    'TCMS_DB_APP_PASSWORD',
    'TCMS_SERVICE_TOKENS',
    'TCMS_ACTOR_PUBLIC_KEYS',
    'TCMS_VERSION',
  ]) {
    const values = { ...BASE_ENV, ...TCMS_ENV };
    delete values[key];
    const managed = composeConfig([BASE, APP, TCMS], values);
    assert.notEqual(managed.status, 0, `${key} fehlt, Compose muss abbrechen`);
    assert.match(managed.stderr, new RegExp(`${key} fehlt - \\./taxtronik tcms`), key);
    const off = composeConfig([BASE, APP], values, { profile: false });
    assert.equal(off.status, 0, `${key}: ohne TCMS-Datei kein Abbruch\n${off.stderr}`);
  }
});
