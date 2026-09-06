import type { TxClient } from '@taxtronik/db';
import { eligibleInboxStaffIdsTx } from './access';

// Fachkatalog: ACCESS-STAFF-PERMISSION-001,
// ACCESS-NOTIFICATION-RECIPIENT-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

async function principalCaseworkersTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
): Promise<string[]> {
  const rows = await tx.clientResponsibility.findMany({
    where: { tenantId, clientId, role: 'HAUPTBEARBEITER' },
    select: { staffId: true },
    orderBy: { staffId: 'asc' },
  });
  const candidates = rows.map((entry) => entry.staffId);
  const eligible = await eligibleInboxStaffIdsTx(tx, tenantId, clientId, candidates);
  return candidates.filter((staffId) => eligible.has(staffId));
}

/** Genau ein berechtigter Hauptbearbeiter wird automatisch zugewiesen. */
export async function resolveInboxAssigneeTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
): Promise<string | null> {
  const eligible = await principalCaseworkersTx(tx, tenantId, clientId);
  return eligible.length === 1 ? eligible[0]! : null;
}

/**
 * Empfaengerkaskade fuer neue Mandantenpost: aktueller Assignee, sonst alle
 * berechtigten Hauptbearbeiter, sonst aktive Admins/Partner. Jede Stufe wird
 * erneut gegen den aktuellen Mandantenzugriff gefiltert.
 */
export async function resolveInboxNotificationRecipientsTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    assignedStaffId?: string | null;
  },
): Promise<string[]> {
  if (input.assignedStaffId) {
    const eligible = await eligibleInboxStaffIdsTx(tx, input.tenantId, input.clientId, [
      input.assignedStaffId,
    ]);
    if (eligible.has(input.assignedStaffId)) return [input.assignedStaffId];
  }

  const principal = await principalCaseworkersTx(tx, input.tenantId, input.clientId);
  if (principal.length > 0) return principal;

  const fallback = await tx.staffUser.findMany({
    where: {
      tenantId: input.tenantId,
      active: true,
      roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const eligible = await eligibleInboxStaffIdsTx(
    tx,
    input.tenantId,
    input.clientId,
    fallback.map((entry) => entry.id),
  );
  return fallback.map((entry) => entry.id).filter((staffId) => eligible.has(staffId));
}
