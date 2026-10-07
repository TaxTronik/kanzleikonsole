// =============================================================================
// Ausstehender Portal-Session-Widerruf je Mandant (Review-Finding B7)
//
// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001, ACCESS-TENANT-RLS-001
//
// Portal-Sessions werden in Redis widerrufen (advanceSessionRevocation aus
// @taxtronik/crypto). Redis ist nicht Teil der Transaktion, die einen Mandanten
// deaktiviert: Scheitert der Widerruf nach dem Commit oder bricht der Prozess
// dazwischen ab, ginge er ohne Spur verloren. Der Aufrufer setzt deshalb in
// derselben Transaktion wie die Deaktivierung
// client.portal_session_revocation_pending_at und löscht den Marker erst nach
// bestätigtem Widerruf (Migration 20261007100300).
//
//   - Setzen überschreibt einen älteren Marker: Ein späterer, bestätigter
//     Widerruf erfasst auch alle vor einer früheren Deaktivierung
//     ausgestellten Sessions.
//   - Löschen ist ein Compare-and-Set auf den gelesenen Wert: Hat eine erneute
//     Deaktivierung den Marker inzwischen neu gesetzt, bleibt er stehen.
//   - Beide Schreibzugriffe umgehen Prismas @updatedAt bewusst: Der Marker ist
//     Betriebszustand, keine Stammdatenänderung; client.updated_at bleibt.
//   - TIMESTAMPTZ(3) hat die Millisekundenauflösung eines JavaScript-Date; der
//     Vergleich beim Löschen ist damit exakt.
// =============================================================================

import type { TxClient } from './tenant-context';

export interface PendingPortalSessionRevocation {
  tenantId: string;
  clientId: string;
  /** Zeitpunkt der Deaktivierung, deren Widerruf noch aussteht. */
  pendingAt: Date;
}

/**
 * Setzt den Marker in der Transaktion, die den Mandanten deaktiviert, und
 * liefert den gespeicherten Wert für das spätere Compare-and-Set. Wirft, wenn
 * der Mandant in diesem Tenant nicht existiert: Die Deaktivierung soll dann
 * nicht ohne Marker committen.
 */
export async function markPortalSessionRevocationPendingTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<PendingPortalSessionRevocation> {
  const rows = await tx.$queryRaw<Array<{ pendingAt: Date }>>`
    UPDATE "client"
       SET "portal_session_revocation_pending_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${input.clientId}::uuid
       AND "tenant_id" = ${input.tenantId}::uuid
    RETURNING "portal_session_revocation_pending_at" AS "pendingAt"
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(
      `Portal-Session-Widerruf: Mandant ${input.clientId} im Tenant ${input.tenantId} nicht gefunden`,
    );
  }
  return { tenantId: input.tenantId, clientId: input.clientId, pendingAt: row.pendingAt };
}

/**
 * Offene Marker, älteste zuerst. Ohne `tenantId` tenantübergreifend; das setzt
 * die Owner-Verbindung voraus (unter RLS sähe die App-Rolle nur ihren Tenant).
 */
export async function listPendingPortalSessionRevocations(
  db: TxClient,
  tenantId?: string,
): Promise<PendingPortalSessionRevocation[]> {
  const rows = await db.client.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      portalSessionRevocationPendingAt: { not: null },
    },
    select: { id: true, tenantId: true, portalSessionRevocationPendingAt: true },
    orderBy: [{ portalSessionRevocationPendingAt: 'asc' }, { id: 'asc' }],
  });
  return rows.flatMap((row) =>
    row.portalSessionRevocationPendingAt
      ? [
          {
            tenantId: row.tenantId,
            clientId: row.id,
            pendingAt: row.portalSessionRevocationPendingAt,
          },
        ]
      : [],
  );
}

/**
 * Löscht den Marker nach bestätigtem Widerruf, aber nur, solange er noch den
 * gelesenen Wert trägt. `false`: inzwischen neu gesetzt oder schon gelöscht.
 */
export async function clearPortalSessionRevocationPendingTx(
  tx: TxClient,
  pending: PendingPortalSessionRevocation,
): Promise<boolean> {
  const cleared = await tx.$executeRaw`
    UPDATE "client"
       SET "portal_session_revocation_pending_at" = NULL
     WHERE "id" = ${pending.clientId}::uuid
       AND "tenant_id" = ${pending.tenantId}::uuid
       AND "portal_session_revocation_pending_at" = ${pending.pendingAt.toISOString()}::timestamptz
  `;
  return cleared === 1;
}
