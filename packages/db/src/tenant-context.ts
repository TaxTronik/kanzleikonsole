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
// =============================================================================

import type { Prisma } from '@prisma/client';
import { prisma, type PrismaClient } from './client';

export type ActorType = 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM';

export interface TenantContext {
  tenantId: string;
  actorId: string | null;
  actorType: ActorType;
}

export type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

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
export async function withTenantContext<T>(
  ctx: TenantContext,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${ctx.tenantId}, true),
        set_config('app.current_actor_id', ${ctx.actorId ?? ''}, true),
        set_config('app.current_actor_type', ${ctx.actorType}, true)
    `;
    return fn(tx);
  });
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
export function assertTenantContext(_: Prisma.TransactionClient): asserts _ is TxClient {
  // No-op zur Laufzeit — dient nur der Typ-Anreicherung in der Aufrufkette.
}
