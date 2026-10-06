// =============================================================================
// n8n-Einstellungen: gemeinsame Bausteine der Services (Review-Finding K-03).
//
// Admin-Kontext und Ergebnisform der Services, die Fehlermeldungen der
// n8n-Administration (F-03), die Revalidierung der Einstellungsseiten und die
// SSRF-Prüfung gespeicherter Zieladressen.
// =============================================================================

import { revalidatePath } from 'next/cache';
import type { ActionResult as BaseActionResult } from '@/server/actions/types';
import { toActionError } from '@/server/actions/to-action-error';
import { assertN8nUrl, urlTargetErrorMessage, type N8nTargetKind } from '@/server/http/ssrf-guard';
import { networkFailure } from '@/server/http/network-error';
import { N8nApiError } from '@/server/n8n/client';

/** Tenant-Kontext eines Admins (aus dem Staff-Gate der Action). */
export interface N8nAdminContext {
  tenantId: string;
  actorId: string;
  actorType: 'STAFF';
}

/** Ergebnis der Services; die Actions geben es unverändert zurück. */
export interface N8nSettingsResult extends BaseActionResult {
  message?: string;
  connectionActivated?: boolean;
}

/** Seiten mit n8n-Status (Einstellungen und Integrationsübersicht). */
export function revalidateN8nSettings(): void {
  revalidatePath('/staff/admin/settings/n8n');
  revalidatePath('/staff/admin/settings/integrations');
}

/** SSRF-Prüfung einer gespeicherten Zieladresse; leer = nicht konfiguriert. */
export async function validateStoredUrl(url: string, kind: N8nTargetKind): Promise<void> {
  if (url) await assertN8nUrl(url, kind);
}

/**
 * F-03: Fehler der n8n-Administration als Meldung — eingeordnet über
 * Fehlerklasse bzw. Fehlercode statt rohem `error.message`. API- und Zieladress-
 * fehler bleiben als Admin-Diagnose sichtbar; Datenbank- und unbekannte Fehler
 * ordnet toActionError ein (generische Meldung, Original nur im Server-Log).
 */
export function n8nAdminErrorMessage(error: unknown): string {
  if (error instanceof N8nApiError) return error.message;
  const target = urlTargetErrorMessage(error);
  if (target) return target;
  const network = networkFailure(error);
  if (network?.kind === 'timeout') return 'n8n hat nicht rechtzeitig geantwortet.';
  if (network) return `n8n ist nicht erreichbar${network.code ? ` (${network.code})` : ''}.`;
  return toActionError(error).error;
}
