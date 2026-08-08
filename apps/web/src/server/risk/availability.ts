import { checkSignalEngine } from '@/server/health/checks';

/**
 * Das Modul-Flag allein reicht nicht: Subsumtion/TCMS ist nur benutzbar, wenn
 * die konfigurierte Risk-/Signal-Engine den authentifizierten Healthcheck
 * tatsächlich beantwortet.
 */
export async function isRiskLayerAvailable(): Promise<boolean> {
  const status = await checkSignalEngine();
  return status?.ok === true;
}
