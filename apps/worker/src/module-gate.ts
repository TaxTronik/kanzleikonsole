// =============================================================================
// Modulschalter eines Tenants für Worker-Jobs (tenant_setting `modules`).
//
// S-01 (Folgearbeit): Der Schalter wird über die App-Rolle im SYSTEM-Kontext
// des Tenants gelesen (withSystemContext, RLS greift), nicht mehr über den
// Owner-Client. Für die Zeile des Tenants ergibt sich derselbe Wert; die
// Einstellungen anderer Tenants sind in diesem Kontext unsichtbar.
// =============================================================================

import { getTcmsConfig } from '@taxtronik/config/env-schema';
import { withSystemContext } from '@taxtronik/db';
import {
  readBooleanTenantModules,
  type BooleanTenantModuleKey,
  type BooleanTenantModules,
} from '@taxtronik/db/tenant-modules';
import { istTcmsAktiv } from '@taxtronik/tcms-client';

export function readWorkerTenantModules(tenantId: string): Promise<BooleanTenantModules> {
  return withSystemContext(tenantId, (tx) => readBooleanTenantModules(tx, tenantId));
}

export async function isWorkerTenantModuleEnabled(
  tenantId: string,
  module: BooleanTenantModuleKey,
): Promise<boolean> {
  return (await readWorkerTenantModules(tenantId))[module];
}

/**
 * TCMS Stufe 2: Ein Job darf das Tax-CMS nur aufrufen, wenn der Tenant das
 * Modul `tcms` eingeschaltet hat UND der Betrieb es deployt hat
 * (TCMS_DEPLOYMENT != disabled). Dieselbe Regel wie in der Web-App
 * (istTcmsAktiv, apps/web/src/server/tcms/dienst.ts).
 */
export async function isWorkerTcmsActive(tenantId: string): Promise<boolean> {
  const config = getTcmsConfig();
  if (config === null) return false;
  return istTcmsAktiv(await isWorkerTenantModuleEnabled(tenantId, 'tcms'), config);
}
