// =============================================================================
// Tenant-Sanity-Helper (Q-5, Konsolidierung von M-1 / P-7 / Q-4-Pattern).
//
// RLS-Policies blockieren Cross-Tenant-Reads, aber Prisma-Insert-Statements
// mit `clientId: <fremde-UUID>` schlagen erst beim FK-Check fehl (Existenz im
// gesamten DB-Cluster) — nicht beim Tenant-Match. Vor jedem Insert mit
// `clientId` o. ä. brauchen wir eine explizite Existenz-Prüfung im aktuellen
// Tenant-Kontext (RLS-aware).
//
// Diese Helper verlagern das Pattern aus 8+ Action-Files an eine Stelle, sodass
// neue Module nicht versehentlich vergessen, die Prüfung einzubauen.
// =============================================================================

import type { TxClient } from '@taxtronik/db';

/**
 * Wirft, wenn `clientId` im aktuellen Tenant-Kontext nicht existiert.
 * Aufruf-Pattern:
 *   await assertClientInTenant(tx, clientId);
 *   const note = await tx.phoneNote.create({ data: { clientId, ... } });
 */
export async function assertClientInTenant(tx: TxClient, clientId: string): Promise<void> {
  const c = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
  if (!c) {
    throw new Error('CLIENT_NOT_FOUND: clientId nicht in diesem Tenant.');
  }
}

/**
 * Wirft, wenn `staffId` im aktuellen Tenant-Kontext nicht existiert.
 * Für ownerStaffId / forwardToStaff / assigneeStaffId-Fälle.
 */
export async function assertStaffInTenant(tx: TxClient, staffId: string): Promise<void> {
  const s = await tx.staffUser.findFirst({ where: { id: staffId }, select: { id: true } });
  if (!s) {
    throw new Error('STAFF_NOT_FOUND: staffId nicht in diesem Tenant.');
  }
}
