// =============================================================================
// Worker-Tenant-Context-Helper.
//
// Spiegelt @taxtronik/db/withTenantContext, aber für den Worker-Owner-Client:
// öffnet eine Transaktion, setzt `app.current_tenant_id` + Actor-Variablen
// (für Audit-Trigger und etwaige zukünftige RLS-aware Code-Pfade) und reicht
// die Transaktion an den Callback durch.
//
// Hintergrund (P-8): der Worker hatte bisher `prismaOwner.notification.create`
// & Co. direkt benutzt — funktional korrekt (BYPASSRLS), aber inkonsistent
// zum Web-App-Pattern, wo alle Mutationen über `withTenantContext` laufen.
// Inkonsistenz ist Defense-in-Depth-Schwäche: wer später RLS-Read/Write-
// Policies enger zieht, würde die Worker-Pfade stillschweigend brechen.
//
// Achtung: Der Owner-Client verbindet als `taxtronik_owner` (BYPASSRLS, seit
// S-01 kein Superuser). RLS wirkt hier also nicht; die gesetzten Variablen
// dienen Audit-Triggern, die Tenant-Filter muss der Job selbst setzen.
// Echte RLS-Bindung bietet `withSystemContext` aus @taxtronik/db (App-Rolle).
//
// S-01 (Folgearbeit): Mandantenbezogene Jobs laufen inzwischen über
// withSystemContext. Für Kerne mit eigenem DB-Parameter (z. B. @taxtronik/tax)
// stellt `systemContextClient` dieselbe Auto-Commit-Semantik wie der
// Owner-Client bereit, aber über die App-Rolle im SYSTEM-Kontext des Tenants.
// withWorkerTenantContext nutzen nur noch Owner-Pfade mit Begründung im Job
// (mail-outbox-deliver, workflow-feedback, dsgvo-retention).
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { TX_OPTIONS, withSystemContext, type TxClient as AppTxClient } from '@taxtronik/db';
import { prismaOwner } from './prisma-owner';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
type AnyFn = (...args: unknown[]) => unknown;

/** Client mit Auto-Commit je Aufruf und `$transaction(fn)` im Tenant-Kontext. */
export type SystemContextClient = AppTxClient & {
  $transaction<T>(fn: (tx: AppTxClient) => Promise<T>): Promise<T>;
};

export async function withWorkerTenantContext<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  // RF-12: dieselben TX-Timeouts wie das Web-Pendant (packages/db) — vorher
  // lief der Worker mit dem Prisma-Default von 5 s und riss bei längeren
  // Job-Transaktionen P2028, während die Web-Seite bewusst 15 s fährt.
  return prismaOwner.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', '', true),
        set_config('app.current_actor_type', 'SYSTEM', true)
    `;
    return fn(tx);
  }, TX_OPTIONS);
}

/**
 * S-01: Ersatz für den Owner-Client in Kernen, die einen eigenen DB-Parameter
 * erwarten. Jeder Aufruf (`db.<modell>.<methode>(…)`, `$queryRaw`,
 * `$executeRaw`, `$transaction(fn)`) läuft in einer eigenen kurzen Transaktion
 * im SYSTEM-Kontext von `tenantId` über die App-Rolle (withSystemContext, RLS):
 * dieselben Transaktionsgrenzen wie beim Owner-Client, aber tenantgebunden.
 */
export function systemContextClient(tenantId: string): SystemContextClient {
  const run = <T>(work: (tx: AppTxClient) => Promise<T>) => withSystemContext(tenantId, work);
  const call = (target: string, method: string | null) => {
    return (...args: unknown[]) =>
      run(async (tx) => {
        const owner = (method ? Reflect.get(tx, target) : tx) as object;
        const fn = Reflect.get(owner, method ?? target) as AnyFn;
        return fn.apply(owner, args);
      });
  };
  return new Proxy({} as SystemContextClient, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === '$transaction') {
        return (fn: unknown) => {
          if (typeof fn !== 'function') {
            throw new Error('systemContextClient: nur $transaction(fn) wird unterstützt');
          }
          return run(fn as (tx: AppTxClient) => Promise<unknown>);
        };
      }
      if (prop.startsWith('$')) return call(prop, null);
      return new Proxy(
        {},
        {
          get(_model, method) {
            if (typeof method !== 'string' || method === 'then') return undefined;
            return call(prop, method);
          },
        },
      );
    },
  });
}
