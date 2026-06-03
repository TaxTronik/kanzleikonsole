// =============================================================================
// Zugriffsmodell pro Tenant — wie weit dürfen Mitarbeiter mandantenübergreifend
// arbeiten?
//
//   OPEN (Default): jeder aktive Mitarbeiter darf an JEDEM Mandanten des Tenants
//     arbeiten. Die Accountability trägt die Audit-Hash-Chain (jeder Zugriff
//     protokolliert). Passt zur vertrauensbasierten Kanzleikultur und ist nach
//     § 203 StGB / § 62 StBerG zulässig (Gehilfen sind ohnehin verschwiegen).
//     Einzelne Mandanten lassen sich per `client.vertraulich` abschirmen.
//   RESTRICTED: nur Admin/Partner + die zugeordneten Berufsträger/Hauptbearbeiter
//     (ClientResponsibility) sehen einen Mandanten — das frühere Verhalten.
//
// Liegt in `tenant_setting.access` als JSON. Bewusst eigener Settings-Key (eine
// Sicherheits-Policy, kein Feature-Toggle). Der Import zieht nur den leichten
// tenant-context-Subpath (kein Owner-Client) — damit rbac.ts es nutzen kann,
// ohne reine Unit-Tests zu beschweren.
// =============================================================================

import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { TenantContext, TxClient } from '@taxtronik/db';

export type ClientAccessMode = 'OPEN' | 'RESTRICTED';

export interface AccessPolicy {
  clientAccessMode: ClientAccessMode;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = { clientAccessMode: 'OPEN' };

/**
 * Reine Zugriffs-Entscheidung (ohne IO, deshalb testbar). Wahrheitstabelle:
 *  - Admin/Partner            → immer Zugriff
 *  - OPEN + nicht vertraulich → Zugriff (kanzleiweite Zusammenarbeit, Default)
 *  - sonst (OPEN+vertraulich ODER RESTRICTED) → nur zugeordnete Berufsträger/
 *    Hauptbearbeiter (`isResponsible`)
 */
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

/** Liest die Policy auf einem bestehenden Tx (für canAccessClient, ein Round-Trip). */
export async function readAccessPolicyTx(tx: TxClient, tenantId: string): Promise<AccessPolicy> {
  const row = await tx.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: KEY_ACCESS } },
  });
  if (!row) return { ...DEFAULT_ACCESS_POLICY };
  const value = row.value as Partial<AccessPolicy>;
  // Defensiv: nur die bekannten Werte zulassen, sonst OPEN (fail-open ist hier
  // GEWOLLT — ein kaputter Setting-Wert soll Mitarbeiter nicht aussperren).
  return { clientAccessMode: value.clientAccessMode === 'RESTRICTED' ? 'RESTRICTED' : 'OPEN' };
}

export async function readAccessPolicy(ctx: TenantContext): Promise<AccessPolicy> {
  return withTenantContext(ctx, (tx) => readAccessPolicyTx(tx, ctx.tenantId));
}

export async function writeAccessPolicy(ctx: TenantContext, cfg: AccessPolicy): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_ACCESS } },
      create: { tenantId: ctx.tenantId, key: KEY_ACCESS, value: cfg as object, updatedBy: ctx.actorId ?? undefined },
      update: { value: cfg as object, updatedBy: ctx.actorId ?? undefined },
    });
  });
}
