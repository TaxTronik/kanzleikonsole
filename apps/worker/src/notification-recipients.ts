// =============================================================================
// Empfänger mandantenbezogener Warn- und Ablaufhinweise der Worker-Jobs.
//
// F-10 (ACCESS-NOTIFICATION-RECIPIENT-001): Zuständigkeiten (`client_responsibility`)
// überdauern eine Deaktivierung. Wer Empfänger direkt daraus ableitet, schreibt
// Hinweise an ausgeschiedene Mitarbeiter, und weil die Zuständigkeit formal noch
// besteht, greift auch kein Admin-Fallback: nach einem Personalwechsel erreicht
// die Warnung niemanden. Alle Ablauf-/Warnjobs lösen ihre Empfänger deshalb hier
// auf: nur aktive und aktuell zugriffsberechtigte Zuständige; bleibt niemand,
// die aktiven, berechtigten ADMIN/PARTNER des Tenants.
// =============================================================================

import type { TxClient } from '@taxtronik/db/tenant-context';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';

export interface ClientWarningRecipientsInput {
  tenantId: string;
  clientId: string;
  /** Zuständige in Prioritätsreihenfolge (z. B. Hauptbearbeiter vor Berufsträger). */
  staffIds: readonly string[];
  /**
   * Eskalation: aktive ADMIN/PARTNER zusätzlich zu den Zuständigen benachrichtigen
   * (GwG-Ablauf, Stufe 3). Ohne diese Option sind sie nur der Fallback.
   */
  includeAdminPartners?: boolean;
}

async function activeAdminPartnerIdsTx(tx: TxClient, tenantId: string): Promise<string[]> {
  const admins = await tx.staffUser.findMany({
    where: { tenantId, active: true, roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return admins.map((admin) => admin.id);
}

/**
 * Liefert die Empfänger eines mandantenbezogenen Hinweises, eindeutig und in
 * stabiler Reihenfolge (Zuständige wie übergeben, danach ADMIN/PARTNER).
 * Eine leere Liste bedeutet: kein aktiver, berechtigter Empfänger vorhanden.
 * Läuft in der Transaktion des Aufrufers, damit Prüfung und Schreiben denselben
 * Stand sehen.
 */
export async function resolveClientWarningRecipientsTx(
  tx: TxClient,
  input: ClientWarningRecipientsInput,
): Promise<string[]> {
  const { tenantId, clientId } = input;
  const responsible = [...new Set(input.staffIds)].filter(Boolean);
  const allowedResponsible = await filterStaffAccessClientTx(tx, tenantId, responsible, clientId);
  const recipients = responsible.filter((staffId) => allowedResponsible.has(staffId));
  if (recipients.length > 0 && !input.includeAdminPartners) return recipients;

  const admins = await activeAdminPartnerIdsTx(tx, tenantId);
  const allowedAdmins = await filterStaffAccessClientTx(tx, tenantId, admins, clientId);
  for (const staffId of admins) {
    if (allowedAdmins.has(staffId) && !recipients.includes(staffId)) recipients.push(staffId);
  }
  return recipients;
}
