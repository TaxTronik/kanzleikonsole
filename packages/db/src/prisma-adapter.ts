import { PrismaPg } from '@prisma/adapter-pg';

const PLACEHOLDER_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid';

export function requireDatabaseUrl(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required to create a Prisma PostgreSQL adapter.`);
  }
  return value;
}

export function optionalDatabaseUrl(value: string | undefined): string {
  return value ?? PLACEHOLDER_DATABASE_URL;
}

// =============================================================================
// Transaktions-Serialisierung auf Adapter-Ebene
//
// Prisma 7 hat keinen Rust-Query-Engine mehr; der JS-Query-Interpreter lädt
// Relationen (`include`/`select` mit Beziehungen) per Default-Strategie `query`
// als separate SELECTs — und feuert sie via `Array.map` GLEICHZEITIG ab. Außer-
// halb einer Transaktion ist das harmlos (jede Query holt sich über den pg.Pool
// eine eigene Connection). INNERHALB einer interaktiven Transaktion hängt aber
// genau EINE dedizierte pg-Connection dran, und `pg.Client` erlaubt nur eine
// Query in-flight: "Calling client.query() when the client is already executing
// a query" — DeprecationWarning ab pg@8, harter Error ab pg@9.
//
// node-postgres reiht die Calls intern korrekt ein (das Ergebnis stimmt), warnt
// aber. Wir serialisieren die SQL-Calls hier explizit — an der einzig richtigen
// Stelle, durch die JEDER echte SQL-Call geht: dem Driver-Adapter. Damit sieht
// pg nie zwei gleichzeitige Queries, das Ergebnis ist identisch, und es ist
// pg@9-fest. (Der serializeTx-Proxy im tenant-context sitzt ÜBER dem Interpreter
// und kann dessen interne Parallel-Subqueries nicht erreichen — bleibt aber als
// zusätzliche Schicht für app-seitige Promise.all-Aufrufe bestehen.)
// =============================================================================

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Serialisiert `queryRaw`/`executeRaw` eines Transaktions-Queryables strikt
 * sequenziell (eine Promise-Chain pro Transaktion = pro Connection).
 */
function serializeTxQueryable<T extends object>(tx: T): T {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue =
    (fn: AnyFn) =>
    (...args: unknown[]): Promise<unknown> => {
      const run = () => fn.apply(tx, args);
      const next = chain.then(run, run);
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
  return new Proxy(tx, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv);
      if ((prop === 'queryRaw' || prop === 'executeRaw') && typeof val === 'function') {
        return enqueue(val as AnyFn);
      }
      return typeof val === 'function' ? (val as AnyFn).bind(target) : val;
    },
  }) as T;
}

/** Wrappt `startTransaction`, sodass das zurückgegebene Queryable serialisiert. */
function wrapAdapter<T extends object>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv);
      if (prop === 'startTransaction' && typeof val === 'function') {
        return async (...args: unknown[]): Promise<object> =>
          serializeTxQueryable((await (val as AnyFn).apply(target, args)) as object);
      }
      return typeof val === 'function' ? (val as AnyFn).bind(target) : val;
    },
  }) as T;
}

/** Wrappt die Adapter-Factory, sodass `connect()` einen gewrappten Adapter liefert. */
function serializeAdapterFactory<T extends object>(factory: T): T {
  return new Proxy(factory, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv);
      if (prop === 'connect' && typeof val === 'function') {
        return async (...args: unknown[]): Promise<object> =>
          wrapAdapter((await (val as AnyFn).apply(target, args)) as object);
      }
      return typeof val === 'function' ? (val as AnyFn).bind(target) : val;
    },
  }) as T;
}

/**
 * Pool-Obergrenzen (P-06). Jeder Prozess hat bis zu zwei Pools: den App-Pool
 * (DATABASE_APP_URL, RLS, Request-Pfad) und den Owner-Pool (DATABASE_URL, Auth,
 * Worker-Jobs, Werkzeuge). Eine interaktive Transaktion hält ihre Verbindung bis
 * zu 15 s; deshalb werden beide Pools je Dienst explizit bemessen:
 *
 *   DATABASE_APP_POOL_MAX    App-Pool   (Default 10 = bisheriger pg-Default)
 *   DATABASE_OWNER_POOL_MAX  Owner-Pool (Default 10 = bisheriger pg-Default)
 *
 * Compose setzt beide je Dienst (app 20/5, worker 5/10); `./taxtronik doctor`
 * prüft die Summe gegen POSTGRES_MAX_CONNECTIONS. Das frühere
 * DATABASE_CONNECTION_LIMIT gilt nur noch als Fallback, wenn die Pool-spezifische
 * Variable fehlt (Skripte, Altinstallationen ohne Compose). Clients ohne Rolle
 * (Restore-Probes, Seeds, Prüfskripte) behalten das bisherige Verhalten.
 */
export type PostgresPoolRole = 'app' | 'owner';

export const DEFAULT_POOL_MAX: Readonly<Record<PostgresPoolRole, number>> = Object.freeze({
  app: 10,
  owner: 10,
});

export const POOL_MAX_ENV: Readonly<Record<PostgresPoolRole, string>> = Object.freeze({
  app: 'DATABASE_APP_POOL_MAX',
  owner: 'DATABASE_OWNER_POOL_MAX',
});

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Ungesetzt/ungültig: Rolle → dokumentierter Default; ohne Rolle → pg-Default. */
export function resolvePoolMax(
  role: PostgresPoolRole | undefined,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const specific = role ? positiveInt(env[POOL_MAX_ENV[role]]) : undefined;
  if (specific !== undefined) return specific;
  const legacy = positiveInt(env['DATABASE_CONNECTION_LIMIT']);
  if (legacy !== undefined) return legacy;
  return role ? DEFAULT_POOL_MAX[role] : undefined;
}

/**
 * Serverseitige Grenzen je Verbindung. Ohne sie läuft eine Abfrage weiter,
 * nachdem Prisma die interaktive Transaktion längst abgebrochen hat, und hält
 * Connection und Locks (gemessen: 128 s statt der 15 s aus TX_OPTIONS).
 */
export interface PostgresSessionLimits {
  /** `statement_timeout` in Millisekunden; deckt auch Wartezeiten auf Locks ab. */
  statementTimeoutMs?: number;
  /** `idle_in_transaction_session_timeout` in Millisekunden. */
  idleInTransactionSessionTimeoutMs?: number;
}

/**
 * Grenzen für den App-Client im Request-Pfad. Beide Werte liegen bewusst über
 * dem Transaktionslimit TX_OPTIONS.timeout (15 s): Was heute rechtzeitig
 * fertig wird, bleibt unberührt; von Prisma aufgegebene Arbeit endet
 * spätestens 5 s später auch in der Datenbank. Sie gelten auch für die
 * Worker-Jobs, die seit S-01 über die App-Rolle laufen (withSystemContext).
 * Owner-, Migrations- und lange Worker-Verbindungen des Owner-Clients bleiben
 * ohne Limit.
 */
export const APP_SESSION_LIMITS = {
  statementTimeoutMs: 20_000,
  idleInTransactionSessionTimeoutMs: 30_000,
} as const satisfies PostgresSessionLimits;

export function createPostgresAdapter(
  connectionString: string,
  limits: PostgresSessionLimits = {},
  poolRole?: PostgresPoolRole,
): PrismaPg {
  const max = resolvePoolMax(poolRole);
  return serializeAdapterFactory(
    new PrismaPg({
      connectionString,
      ...(max !== undefined ? { max } : {}),
      ...(limits.statementTimeoutMs !== undefined
        ? { statement_timeout: limits.statementTimeoutMs }
        : {}),
      ...(limits.idleInTransactionSessionTimeoutMs !== undefined
        ? { idle_in_transaction_session_timeout: limits.idleInTransactionSessionTimeoutMs }
        : {}),
    }),
  );
}
