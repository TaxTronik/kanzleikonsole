// =============================================================================
// n8n-Einstellungen: Verbindung speichern, zurücksetzen, Secrets und
// Rückkanal-Zugang (Review-Finding K-03).
//
// Secrets: Signatur-Secret und API-Key gehen nur verschlüsselt in die
// Datenbank (writeN8nConfigTx) und erscheinen im Audit ausschließlich als
// „***“. Ein neu erzeugtes Signatur-Secret bzw. Rückkanal-Token wird genau
// einmal an den anfragenden Admin zurückgegeben und nie geloggt.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { withTenantContext } from '@taxtronik/db';
import { deleteTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { evidenceService } from '@/server/container';
import { cancelPendingN8nDeliveries } from '@/server/n8n/deliveries';
import { rotateN8nCallbackCredential } from '@/server/n8n/callback-credentials';
import type { N8nCallbackCredentialDisplay } from '@/server/n8n/callback-import-setup';
import {
  defaultN8nCallbackBase,
  resolveN8nConfig,
  writeN8nConfigTx,
  type N8nConfig,
} from '@/server/settings/n8n';
import {
  connectionChange,
  connectionSaveRejection,
  effectiveConnectionSecrets,
  normalizedConnectionConfig,
  type N8nConnectionInput,
} from './validation';
import {
  n8nAdminErrorMessage,
  revalidateN8nSettings,
  validateStoredUrl,
  type N8nAdminContext,
  type N8nSettingsResult,
} from './shared';

/**
 * Feldgenaue SSRF-Prüfung mit eindeutigem "Nicht gespeichert"-Präfix: der
 * frühere nackte SSRF-Fehler ("Hostname löst auf eine private Adresse auf")
 * stand neben dem API-Test und wurde als Test-Ergebnis fehlgedeutet — der
 * Admin hielt den verworfenen Save für erfolgreich.
 */
async function connectionUrlRejection(data: N8nConnectionInput): Promise<string | null> {
  try {
    await validateStoredUrl(data.webhookBaseUrl, 'webhook');
  } catch (error) {
    return `Nicht gespeichert — Produktions-Webhook-Präfix: ${n8nAdminErrorMessage(error)} Tipp: Verwenden Sie die öffentliche n8n-Adresse hinter dem Reverse-Proxy — nie localhost oder den internen Compose-Service.`;
  }
  try {
    await validateStoredUrl(data.apiBaseUrl, 'api');
  } catch (error) {
    return `Nicht gespeichert — Public API: ${n8nAdminErrorMessage(error)}`;
  }
  return null;
}

/**
 * Speichert Verbindung, Änderungsfolgen und Audit in einer Transaktion: bei
 * zustellrelevanten Änderungen werden wartende Zustellungen abgebrochen, bei
 * neuem Signatur-Secret alle Routen deaktiviert und zur Neuprüfung markiert.
 */
async function writeN8nConnectionTx(
  ctx: N8nAdminContext,
  previous: N8nConfig,
  cfg: N8nConfig,
): Promise<number> {
  const { signingSecretChanged, deliveryConfigurationChanged } = connectionChange(previous, cfg);
  return withTenantContext(ctx, async (tx) => {
    const connectionId = await writeN8nConfigTx(tx, ctx, cfg);
    const cancelled = deliveryConfigurationChanged
      ? await cancelPendingN8nDeliveries(tx, {
          tenantId: ctx.tenantId,
          reason: 'n8n-Verbindungs- oder Signaturkonfiguration wurde geändert',
        })
      : { deliveryCount: 0, outboxIds: [] };
    if (signingSecretChanged) {
      await tx.n8nWebhookEndpoint.updateMany({
        where: { tenantId: ctx.tenantId },
        data: {
          enabled: false,
          verifiedAt: null,
          verificationOk: null,
          verificationError: 'Signatur-Secret geändert; Route muss erneut getestet werden.',
        },
      });
    }
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.update',
      resourceType: 'n8n_connection',
      resourceId: connectionId,
      after: {
        name: cfg.name,
        kind: cfg.kind,
        routingMode: cfg.routingMode,
        enabled: cfg.enabled,
        uiBaseUrl: cfg.uiBaseUrl || null,
        callbackBaseUrl: cfg.callbackBaseUrl,
        webhookBaseUrl: cfg.webhookBaseUrl || null,
        apiBaseUrl: cfg.apiBaseUrl || null,
        signingSecret: cfg.hmacSecret ? '***' : null,
        apiKey: cfg.apiKey ? '***' : null,
        signingSecretChanged,
        cancelledPendingDeliveries: cancelled.deliveryCount,
      },
    });
    return cancelled.deliveryCount;
  });
}

/** Verbindung speichern: fachliche Prüfung, SSRF-Prüfung, Transaktion, Meldung. */
export async function saveN8nConnection(
  ctx: N8nAdminContext,
  data: N8nConnectionInput,
): Promise<N8nSettingsResult> {
  const previous = await resolveN8nConfig(ctx);
  const secrets = effectiveConnectionSecrets(previous, data);
  const callbackBaseUrl = data.callbackBaseUrl.trim() || defaultN8nCallbackBase(data.kind);

  const rejection = connectionSaveRejection(previous, data, secrets);
  if (rejection) return { ok: false, error: rejection };
  const urlRejection = await connectionUrlRejection(data);
  if (urlRejection) return { ok: false, error: urlRejection };

  const cfg = normalizedConnectionConfig(previous, data, secrets, callbackBaseUrl);
  const { signingSecretChanged } = connectionChange(previous, cfg);
  const cancelledPendingDeliveries = await writeN8nConnectionTx(ctx, previous, cfg);
  revalidateN8nSettings();
  return {
    ok: true,
    message: signingSecretChanged
      ? `Verbindung gespeichert; Routen müssen wegen des neuen Signatur-Secrets erneut getestet werden (${cancelledPendingDeliveries} wartende Zustellungen abgebrochen).`
      : 'Verbindung gespeichert.',
  };
}

/** Integration deaktivieren: Routen, Credentials und Legacy-Eintrag entfernen. */
export async function resetN8nConnection(ctx: N8nAdminContext): Promise<N8nSettingsResult> {
  const reset = await withTenantContext(ctx, async (tx) => {
    const current = await tx.n8nConnection.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { id: true },
    });
    const cancelled = await cancelPendingN8nDeliveries(tx, {
      tenantId: ctx.tenantId,
      reason: 'n8n-Integration wurde deaktiviert und zurückgesetzt',
    });
    await tx.n8nWebhookEndpoint.deleteMany({ where: { tenantId: ctx.tenantId } });
    const connection = await tx.n8nConnection.upsert({
      where: { tenantId: ctx.tenantId },
      create: {
        tenantId: ctx.tenantId,
        name: 'TaxTronik n8n',
        kind: 'BUNDLED',
        routingMode: 'DISABLED',
        enabled: false,
      },
      update: {
        name: 'TaxTronik n8n',
        routingMode: 'DISABLED',
        enabled: false,
        uiBaseUrl: null,
        apiBaseUrl: null,
        webhookBaseUrl: null,
        callbackBaseUrl: null,
        apiKeyEncrypted: null,
        signingSecretEncrypted: null,
        callbackTokenHash: null,
        callbackScopes: [],
        healthCheckedAt: null,
        healthOk: null,
        healthError: null,
      },
      select: { id: true },
    });
    await deleteTenantSettingValue(tx, ctx.tenantId, 'integrations.n8n');
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.delete',
      resourceType: 'n8n_connection',
      resourceId: current?.id ?? connection.id,
      after: {
        disabled: true,
        routesRemoved: true,
        credentialsRemoved: true,
        cancelledPendingDeliveries: cancelled.deliveryCount,
      },
    });
    return cancelled.deliveryCount;
  });
  revalidateN8nSettings();
  return {
    ok: true,
    message: `Integration deaktiviert; Credentials und Routen entfernt (${reset} wartende Zustellungen abgebrochen).`,
  };
}

/** Neues Signatur-Secret zum Eintragen im Formular (nicht gespeichert, nicht geloggt). */
export function generateN8nSigningSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Rotiert das Callback-Token. Der Klartext steht genau in diesem Ergebnis. */
export async function rotateN8nCallbackAccess(
  ctx: N8nAdminContext,
  scopes: string[],
): Promise<N8nSettingsResult & { credential?: N8nCallbackCredentialDisplay }> {
  let rotated: Awaited<ReturnType<typeof rotateN8nCallbackCredential>>;
  try {
    rotated = await rotateN8nCallbackCredential(ctx, scopes);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      error:
        code === 'P2025'
          ? 'Bitte zuerst die n8n-Verbindung speichern.'
          : 'Callback-Zugang konnte nicht atomar rotiert werden.',
    };
  }

  const { token, connection } = rotated;
  revalidateN8nSettings();
  return {
    ok: true,
    message: 'Callback-Zugang neu erzeugt. Das Token wird nur jetzt angezeigt.',
    credential: {
      keyId: connection.callbackKeyId,
      token,
      baseUrl: `${(connection.callbackBaseUrl || defaultN8nCallbackBase(connection.kind)).replace(
        /\/$/,
        '',
      )}/api/integrations/n8n/v1`,
      scopes: connection.callbackScopes,
    },
  };
}
