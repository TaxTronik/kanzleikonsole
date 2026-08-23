import type { TxClient } from '@taxtronik/db';
import { canOtherStaffAccessClientTx, filterStaffAccessClientTx } from '@/server/auth/rbac';
import { ActionError } from '@/server/actions/portal-action';

export interface AppointmentStaffOption {
  id: string;
  fullName: string;
}

/**
 * Liefert genau die aktiven Personen, die den Mandanten nach der zentralen
 * Kanzlei-Policy sehen dürfen. Damit folgt die Portal-Auswahl sowohl dem
 * OPEN-/RESTRICTED-Modus als auch dem Vertraulichkeitsventil.
 */
export async function readAppointmentStaffOptionsTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
): Promise<AppointmentStaffOption[]> {
  const activeStaff = await tx.staffUser.findMany({
    where: { active: true },
    orderBy: { fullName: 'asc' },
    select: { id: true, fullName: true },
  });
  const allowedStaff = await filterStaffAccessClientTx(
    tx,
    tenantId,
    activeStaff.map((staff) => staff.id),
    clientId,
  );
  return activeStaff.filter((staff) => allowedStaff.has(staff.id));
}

/** Serverseitiges Gegenstück zur gefilterten Auswahl; schützt vor Form-Manipulation. */
export async function assertAppointmentStaffOptionTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
  staffId: string | null | undefined,
): Promise<void> {
  if (!staffId) return;
  if (!(await canOtherStaffAccessClientTx(tx, tenantId, staffId, clientId))) {
    throw new ActionError('Die ausgewählte Person ist für diesen Mandanten nicht verfügbar.');
  }
}
