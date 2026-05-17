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
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { prismaOwner } from './prisma-owner';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export async function withWorkerTenantContext<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prismaOwner.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', '', true),
        set_config('app.current_actor_type', 'SYSTEM', true)
    `;
    return fn(tx);
  });
}
