// =============================================================================
// Modulschalter eines Tenants für Worker-Jobs (tenant_setting `modules`).
//
// S-01 (Folgearbeit): Der Schalter wird über die App-Rolle im SYSTEM-Kontext
// des Tenants gelesen (withSystemContext, RLS greift), nicht mehr über den
// Owner-Client. Für die Zeile des Tenants ergibt sich derselbe Wert; die
// Einstellungen anderer Tenants sind in diesem Kontext unsichtbar.
// =============================================================================

import { withSystemContext } from '@taxtronik/db';
import {
  readBooleanTenantModules,
  type BooleanTenantModuleKey,
  type BooleanTenantModules,
} from '@taxtronik/db/tenant-modules';

export function readWorkerTenantModules(tenantId: string): Promise<BooleanTenantModules> {
  return withSystemContext(tenantId, (tx) => readBooleanTenantModules(tx, tenantId));
}

export async function isWorkerTenantModuleEnabled(
  tenantId: string,
  module: BooleanTenantModuleKey,
): Promise<boolean> {
  return (await readWorkerTenantModules(tenantId))[module];
}
