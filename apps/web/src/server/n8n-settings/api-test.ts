// =============================================================================
// n8n-Einstellungen: Public-API-Verbindungstest (Review-Finding K-03).
//
// Der gespeicherte API-Key geht nie an einen fremden Host. Das Ergebnis wird
// nur dann als Gesundheitsstatus gespeichert, wenn genau die gespeicherte
// Konfiguration getestet wurde.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import { N8nApiClient } from '@/server/n8n/client';
import { resolveN8nConfig } from '@/server/settings/n8n';
import { storedApiKeyLeavesInstance, type N8nConnectionInput } from './validation';
import {
  n8nAdminErrorMessage,
  revalidateN8nSettings,
  validateStoredUrl,
  type N8nAdminContext,
  type N8nSettingsResult,
} from './shared';

type ApiHealth = { healthOk: true; healthError: null } | { healthOk: false; healthError: string };

async function recordApiHealth(
  ctx: N8nAdminContext,
  connectionId: string,
  health: ApiHealth,
): Promise<void> {
  await withTenantContext(ctx, (tx) =>
    tx.n8nConnection.updateMany({
      where: { id: connectionId, tenantId: ctx.tenantId },
      data: { healthCheckedAt: new Date(), ...health },
    }),
  );
}

/** Pingt die Public API mit dem eingegebenen oder dem gespeicherten Key. */
export async function testN8nApi(
  ctx: N8nAdminContext,
  data: N8nConnectionInput,
): Promise<N8nSettingsResult> {
  const previous = await resolveN8nConfig(ctx);
  if (storedApiKeyLeavesInstance(previous, data)) {
    return {
      ok: false,
      error:
        'Der gespeicherte API-Key wird nicht an eine andere n8n-Instanz gesendet. Bitte den API-Key der neuen Instanz eingeben und erneut testen.',
    };
  }
  const apiKey = data.keepApiKey ? previous.apiKey : data.apiKey;
  const apiBaseUrl = data.apiBaseUrl.trim();
  const testingStoredConfig = Boolean(
    previous.connectionId &&
    data.keepApiKey &&
    apiBaseUrl.replace(/\/$/, '') === previous.apiBaseUrl.replace(/\/$/, ''),
  );
  try {
    await validateStoredUrl(apiBaseUrl, 'api');
    const result = await new N8nApiClient(apiBaseUrl, apiKey).ping();
    if (previous.connectionId && testingStoredConfig) {
      await recordApiHealth(ctx, previous.connectionId, { healthOk: true, healthError: null });
    }
    revalidateN8nSettings();
    return {
      ok: true,
      message: `API erreichbar (${result.latencyMs} ms, authentifiziert).`,
    };
  } catch (error) {
    const message = n8nAdminErrorMessage(error);
    if (previous.connectionId && testingStoredConfig) {
      await recordApiHealth(ctx, previous.connectionId, {
        healthOk: false,
        healthError: message.slice(0, 500),
      });
    }
    revalidateN8nSettings();
    return { ok: false, error: message };
  }
}
