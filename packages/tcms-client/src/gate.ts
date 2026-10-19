// =============================================================================
// Aktivierung des TCMS (TCMS Stufe 2): Modul `tcms` des Tenants an UND
// TCMS_DEPLOYMENT != disabled (getTcmsConfig() !== null). Eine Funktion für Web
// und Worker, damit beide dieselbe Regel anwenden; das Lesen des Modulschalters
// bleibt beim Aufrufer (Web: readModulesTx, Worker: readBooleanTenantModules).
// =============================================================================

import type { TcmsConfig } from '@taxtronik/config/env-schema';

export function istTcmsAktiv(modulAn: boolean, config: TcmsConfig | null): boolean {
  return modulAn === true && config !== null;
}
