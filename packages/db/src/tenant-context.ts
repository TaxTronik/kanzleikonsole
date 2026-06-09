// =============================================================================
// Tenant-Context-Helper.
//
// Setzt Session-Variablen (`app.current_tenant_id`, `app.current_actor_id`,
// `app.current_actor_type`) innerhalb einer Transaktion, damit die
// Postgres-RLS-Policies greifen.
//
// **Jeder DB-Zugriff der App MUSS durch withTenantContext gehen.**
// Direkter `prisma.xy.findMany()`-Aufruf ohne Context wird durch RLS blockiert
// (App-Role sieht NICHTS). Das ist Absicht — Defense in Depth gegen vergessene
// Tenant-Filter.
//
// TX-Serializer: Der tx-Client wird per Proxy serialisiert. Hintergrund:
// `prisma.$transaction()` hält genau eine pg-Connection. Mit dem
// driver-adapter `@prisma/adapter-pg` (Prisma 7) gehen Queries direkt an den
// pg.Client — und pg.Client erlaubt nur eine Query in-flight pro Connection
// (Deprecation-Warning ab pg@8, Error ab pg@9). Code wie
// `Promise.all([tx.a.findMany(), tx.b.findMany()])` würde sonst spammen.
// Der Proxy reiht alle Calls in eine Promise-Chain ein, läuft also sequenziell
// — was sie unter dem alten Query-Engine ohnehin taten, nur stillschweigend.
//
// Hinweis: Eine ZWEITE, tiefere Serialisierungs-Schicht sitzt im Driver-Adapter
// (prisma-adapter.ts). Sie ist nötig, weil Prisma 7s JS-Interpreter die
// Relations-Subqueries EINES `findUnique`/`findMany` mit `include` intern
// parallel feuert — unterhalb dieses Proxys. Beide Schichten zusammen halten
// die eine Tx-Connection garantiert single-flight (pg@9-fest).
// =============================================================================

import type { Prisma } from '@prisma/client';
import { prisma } from './client';

export type ActorType = 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM';

export interface TenantContext {
  tenantId: string;
  actorId: string | null;
  actorType: ActorType;
}

export type TxClient = Prisma.TransactionClient;

/**
 * Führt einen Callback mit gesetztem Tenant-Kontext aus.
 *
 * - Öffnet eine Transaktion (RLS-Variablen leben pro-Transaktion).
 * - Setzt `app.current_tenant_id`, `app.current_actor_id`, `app.current_actor_type`.
 * - Führt den Callback mit dem Transaktions-Client aus.
 *
 * Beispiel:
 * ```ts
 * await withTenantContext(ctx, async (tx) => {
 *   return tx.client.findMany();
 * });
 * ```
 */
function serializeTx<T extends object>(tx: T): T {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <R>(work: () => R | Promise<R>): Promise<R> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<R>;
  };
  const modelCache = new WeakMap<object, unknown>();
  const wrapModel = (model: object) => {
    const cached = modelCache.get(model);
    if (cached) return cached;
    const proxy = new Proxy(model, {
      get(target, prop, recv) {
        const val = Reflect.get(target, prop, recv);
        if (typeof val !== 'function') return val;
        return (...args: unknown[]) =>
          enqueue(() => (val as (...a: unknown[]) => unknown).apply(target, args));
      },
    });
    modelCache.set(model, proxy);
    return proxy;
  };
  return new Proxy(tx, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv);
      if (typeof val === 'function') {
        return (...args: unknown[]) =>
          enqueue(() => (val as (...a: unknown[]) => unknown).apply(target, args));
      }
      if (typeof val === 'object' && val !== null) return wrapModel(val);
      return val;
    },
  }) as T;
}

// Der serializeTx-Proxy reiht alle Queries einer Transaktion strikt
// sequenziell (siehe Kopfkommentar). Vormals parallele Promise.all-Aufrufe
// laufen damit nacheinander — die Summe kann den Prisma-Default von 5 s für
// interaktive Transaktionen reißen (P2028), z. B. auf Dashboards mit vielen
// Aggregationen unter Last. Daher großzügigeres Limit; maxWait bleibt knapp,
// damit ein erschöpfter Pool schnell sichtbar wird statt lange zu blockieren.
// RF-12: exportiert, damit der Worker (withWorkerTenantContext) dieselben
// Timeouts nutzt statt beim Prisma-Default von 5 s zu bleiben.
export const TX_OPTIONS = { timeout: 15_000, maxWait: 5_000 } as const;

export async function withTenantContext<T>(
  ctx: TenantContext,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = serializeTx(rawTx);
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${ctx.tenantId}, true),
        set_config('app.current_actor_id', ${ctx.actorId ?? ''}, true),
        set_config('app.current_actor_type', ${ctx.actorType}, true)
    `;
    return fn(tx);
  }, TX_OPTIONS);
}

/**
 * Führt einen Callback im SYSTEM-Kontext (z. B. Worker-Jobs ohne User).
 * Tenant-ID muss trotzdem gesetzt sein — keine Cross-Tenant-Operationen.
 */
export async function withSystemContext<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return withTenantContext({ tenantId, actorId: null, actorType: 'SYSTEM' }, fn);
}

/**
 * Type-Guard, damit Code nicht versehentlich an Funktionen ohne Context-Wrapper
 * geht. Wird von ESLint-Custom-Rule (später) ausgewertet.
 */
export function assertTenantContext(_: Prisma.TransactionClient): void {
  // No-op zur Laufzeit — dient nur der Typ-Anreicherung in der Aufrufkette.
}
