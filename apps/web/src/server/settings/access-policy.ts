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

import { cache } from 'react';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { TenantContext } from '@taxtronik/db';
import { readAccessPolicyTx, type AccessPolicy } from '@taxtronik/db/staff-client-access';
import { writeTenantSettingValue } from '@taxtronik/db/tenant-settings';

export {
  DEFAULT_ACCESS_POLICY,
  decideClientAccess,
  readAccessPolicyTx,
  type AccessPolicy,
  type ClientAccessMode,
} from '@taxtronik/db/staff-client-access';

const KEY_ACCESS = 'access';

// Standalone-Variante (eigene Tx) — wird im Zugriffs-Gate pro Request u. U.
// mehrfach gerufen. cache() request-scoped auf Primitiven (s. modules.ts).
// readAccessPolicyTx (auf bestehender Tx, ein Round-Trip) bleibt ungecacht.
const readAccessPolicyCached = cache(
  (
    tenantId: string,
    actorId: TenantContext['actorId'],
    actorType: TenantContext['actorType'],
  ): Promise<AccessPolicy> =>
    withTenantContext({ tenantId, actorId, actorType }, (tx) => readAccessPolicyTx(tx, tenantId)),
);

export function readAccessPolicy(ctx: TenantContext): Promise<AccessPolicy> {
  return readAccessPolicyCached(ctx.tenantId, ctx.actorId, ctx.actorType);
}

export async function writeAccessPolicy(ctx: TenantContext, cfg: AccessPolicy): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY_ACCESS,
      value: cfg as object,
      updatedBy: ctx.actorId,
    });
  });
}
