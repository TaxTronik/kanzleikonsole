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
 * Pool-Obergrenze. Ohne `max` nutzt der pg-Pool seinen Default (~10). Da jede
 * Anfrage eine Connection für die volle interaktive Transaktion (≤15 s) hält,
 * kann das unter Staff-Concurrency + Worker zu Pool-Erschöpfung führen. Über
 * DATABASE_CONNECTION_LIMIT pro Deployment explizit setzbar (App typischerweise
 * höher als Worker; bei sehr hoher Concurrency PgBouncer davor). Ungesetzt →
 * pg-Default (verhaltensneutral).
 */
function poolMaxFromEnv(): number | undefined {
  const raw = process.env['DATABASE_CONNECTION_LIMIT'];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function createPostgresAdapter(connectionString: string): PrismaPg {
  const max = poolMaxFromEnv();
  return serializeAdapterFactory(
    new PrismaPg({ connectionString, ...(max !== undefined ? { max } : {}) }),
  );
}
