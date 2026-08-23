// =============================================================================
// Gemeinsame Mandanten-Zugriffspolicy fuer Web-App und Worker.
//
// Benachrichtigungen koennen erst deutlich nach einer Zuweisung entstehen.
// Deshalb reicht es nicht, Empfaenger nur beim Anlegen zu pruefen: direkt vor
// dem Versand muss der aktuelle OPEN/RESTRICTED-/Vertraulich-Stand gelten.
// Dieses leichte Subpath-Modul zieht bewusst keinen Owner-Client ein.
// =============================================================================

import type { TxClient } from './tenant-context';

export type ClientAccessMode = 'OPEN' | 'RESTRICTED';

export interface AccessPolicy {
  clientAccessMode: ClientAccessMode;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = { clientAccessMode: 'OPEN' };

export function decideClientAccess(input: {
  isAdmin: boolean;
  mode: ClientAccessMode;
  vertraulich: boolean;
  isResponsible: boolean;
}): boolean {
  if (input.isAdmin) return true;
  if (input.mode === 'OPEN' && !input.vertraulich) return true;
  return input.isResponsible;
}

const KEY_ACCESS = 'access';

export async function readAccessPolicyTx(tx: TxClient, tenantId: string): Promise<AccessPolicy> {
  const row = await tx.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: KEY_ACCESS } },
  });
  if (!row) return { ...DEFAULT_ACCESS_POLICY };
  const value = row.value as Partial<AccessPolicy>;
  return { clientAccessMode: value.clientAccessMode === 'RESTRICTED' ? 'RESTRICTED' : 'OPEN' };
}

/**
 * Liefert aus einer beliebigen Mitarbeiterliste nur aktuell aktive Personen,
 * die den Mandanten nach dessen jetziger Policy sehen duerfen.
 *
 * ADMIN/PARTNER bleiben stets berechtigt. Im OPEN-Modus sind alle aktiven
 * Tenant-Mitarbeiter fuer nicht vertrauliche Mandanten berechtigt; andernfalls
 * braucht es eine BERUFSTRAEGER-/HAUPTBEARBEITER-Zuordnung.
 */
export async function filterStaffAccessClientTx(
  tx: TxClient,
  tenantId: string,
  staffIds: readonly string[],
  clientId: string,
): Promise<Set<string>> {
  const uniqueStaffIds = [...new Set(staffIds)].filter(Boolean);
  if (uniqueStaffIds.length === 0) return new Set();

  const staff = await tx.staffUser.findMany({
    where: { id: { in: uniqueStaffIds }, tenantId, active: true },
    select: { id: true, roles: { select: { role: true } } },
  });
  if (staff.length === 0) return new Set();

  const policy = await readAccessPolicyTx(tx, tenantId);
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId },
    select: { vertraulich: true },
  });
  if (!client) return new Set();

  const needResponsibility = policy.clientAccessMode === 'RESTRICTED' || client.vertraulich;
  const responsible = new Set<string>(
    needResponsibility
      ? (
          await tx.clientResponsibility.findMany({
            where: {
              tenantId,
              clientId,
              staffId: { in: staff.map((entry) => entry.id) },
              role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] },
            },
            select: { staffId: true },
          })
        ).map((entry) => entry.staffId)
      : [],
  );

  const allowed = new Set<string>();
  for (const entry of staff) {
    let isAdmin = false;
    for (const { role } of entry.roles) {
      if (role === 'ADMIN' || role === 'PARTNER') {
        isAdmin = true;
        break;
      }
    }
    if (
      decideClientAccess({
        isAdmin,
        mode: policy.clientAccessMode,
        vertraulich: client.vertraulich,
        isResponsible: responsible.has(entry.id),
      })
    ) {
      allowed.add(entry.id);
    }
  }
  return allowed;
}

export async function canStaffAccessClientTx(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientId: string,
): Promise<boolean> {
  return (await filterStaffAccessClientTx(tx, tenantId, [staffId], clientId)).has(staffId);
}
