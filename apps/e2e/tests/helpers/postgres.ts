import { execFileSync } from 'node:child_process';

type Run = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => string;

/** PostgreSQL der Browser-Fixture. Die Zugangsdaten können vom App-Benutzer abweichen. */
function postgresTarget(env: NodeJS.ProcessEnv) {
  const url = appDatabaseUrl(env.DATABASE_URL);
  const urlDatabase = url && decodeURIComponent(url.pathname.slice(1));
  const setting = (e2e: string, pg: string, fallback: string) => env[e2e] || env[pg] || fallback;
  const database = setting('E2E_POSTGRES_DB', 'PGDATABASE', urlDatabase || 'taxtronik');
  if (urlDatabase && database !== urlDatabase) {
    throw new Error(
      'E2E-PostgreSQL: Fixture-Datenbank und DATABASE_URL bezeichnen unterschiedliche Datenbanken.',
    );
  }
  // libpq interpretiert -d mit "=" oder PostgreSQL-URL als neue Verbindung.
  if (database.includes('=') || /^postgres(?:ql)?:\/\//i.test(database)) {
    throw new Error('E2E-PostgreSQL benötigt einen einzelnen Datenbanknamen.');
  }
  return {
    database,
    host: setting(
      'E2E_POSTGRES_HOST',
      'PGHOST',
      url?.hostname.replace(/^\[|\]$/g, '') || 'localhost',
    ),
    port: setting('E2E_POSTGRES_PORT', 'PGPORT', url?.port || '5432'),
    user: setting(
      'E2E_POSTGRES_USER',
      'PGUSER',
      (url && decodeURIComponent(url.username)) || 'taxtronik',
    ),
    password:
      env.E2E_POSTGRES_PASSWORD ??
      env.PGPASSWORD ??
      (url?.password ? decodeURIComponent(url.password) : 'taxtronik'),
  };
}

export function psql(
  query: string,
  env: NodeJS.ProcessEnv = process.env,
  run: Run = execFileSync,
): string {
  const { database, host, port, user, password } = postgresTarget(env);
  const args = ['-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-t', '-A', '-c', query];
  const options = {
    encoding: 'utf8',
    env: { ...env, PGPASSWORD: password },
    stdio: ['pipe', 'pipe', 'pipe'],
  } satisfies Parameters<Run>[2];
  const inContainer = (name: string) =>
    run('docker', ['exec', '--env', 'PGPASSWORD', '--', name, 'psql', ...args], options).trim();
  if (env.E2E_POSTGRES_CONTAINER) return inContainer(env.E2E_POSTGRES_CONTAINER);
  try {
    return run('psql', ['-h', host, '-p', port, ...args], options).trim();
  } catch (error) {
    // Docker ersetzt nur ein fehlendes lokales Clientprogramm im Standard-Dev-Stack.
    // Eine fehlgeschlagene oder teilweise ausgeführte SQL-Anweisung wird nie wiederholt.
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
      !['localhost', '127.0.0.1', '::1'].includes(host) ||
      port !== '5432'
    )
      throw error;
    return inContainer('taxtronik-postgres');
  }
}

function appDatabaseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname.length > 1) return url;
  } catch {
    // Die Verbindungs-URL kann Zugangsdaten enthalten.
  }
  throw new Error(
    'E2E-PostgreSQL benötigt eine gültige PostgreSQL-DATABASE_URL mit Datenbanknamen.',
  );
}
