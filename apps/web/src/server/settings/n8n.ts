// =============================================================================
// Tenant-spezifische n8n-Verbindung
//
// Neue Installationen verwenden die normalisierten Tabellen
// n8n_connection → n8n_webhook_endpoint → n8n_event_subscription. Der alte
// tenant_setting-Eintrag bleibt ausschließlich als lesbarer Migrations- und
// ENV-Fallback erhalten. Beim nächsten Speichern wird er atomar entfernt.
// =============================================================================

import { env } from '@taxtronik/config';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { encryptSecret, readEncryptedSetting } from '@/server/crypto/secret-box';

const LEGACY_KEY = 'integrations.n8n';

export const N8N_CALLBACK_SCOPES = [
  'requests:read',
  'gwg:read',
  'research:write',
  'inbound-mail:write',
] as const;

export function defaultN8nCallbackBase(kind: N8nConnectionKindName): string {
  if (kind === 'BUNDLED') {
    return env.NODE_ENV === 'production' ? 'http://app:3000' : 'http://host.docker.internal:3000';
  }
  return env.NEXTAUTH_URL.replace(/\/$/, '');
}

export type N8nConnectionKindName = 'BUNDLED' | 'SELF_HOSTED' | 'CLOUD';
export type N8nRoutingModeName = 'DISABLED' | 'LEGACY' | 'EXPLICIT';

/** Server-interne Konfiguration. Secret-Werte niemals an Client Components geben. */
export interface N8nConfig {
  connectionId: string | null;
  name: string;
  kind: N8nConnectionKindName;
  routingMode: N8nRoutingModeName;
  enabled: boolean;
  /** Öffentliche n8n-Oberfläche, ohne /api/v1 oder /webhook. */
  uiBaseUrl: string;
  /** Von n8n aus erreichbare TaxTronik-Basis für versionierte Callbacks. */
  callbackBaseUrl: string;
  /** Nur Legacy: Präfix, an das früher /<event> angehängt wurde. */
  webhookBaseUrl: string;
  /** Signiert ausgehende TaxTronik-Events. */
  hmacSecret: string;
  /** n8n Public API, typischerweise .../api/v1. */
  apiBaseUrl: string;
  apiKey: string;
  callbackKeyId: string;
  callbackConfigured: boolean;
  callbackScopes: string[];
  healthCheckedAt: string | null;
  healthOk: boolean | null;
  healthError: string | null;
  source: 'CONNECTION' | 'LEGACY_SETTING' | 'ENV';
}

export const DEFAULT_N8N_CONFIG: N8nConfig = {
  connectionId: null,
  name: 'TaxTronik n8n',
  kind: 'SELF_HOSTED',
  routingMode: 'DISABLED',
  enabled: false,
  uiBaseUrl: '',
  callbackBaseUrl: '',
  webhookBaseUrl: '',
  hmacSecret: '',
  apiBaseUrl: '',
  apiKey: '',
  callbackKeyId: '',
  callbackConfigured: false,
  callbackScopes: [],
  healthCheckedAt: null,
  healthOk: null,
  healthError: null,
  source: 'CONNECTION',
};

interface LegacyN8nStored {
  webhookBaseUrl?: string;
  hmacEncrypted?: string;
  hmacSecret?: string;
  apiBaseUrl?: string;
  apiKeyEncrypted?: string;
  apiKey?: string;
}

export interface N8nStatus {
  webhookConfigured: boolean;
  apiConfigured: boolean;
  callbackConfigured: boolean;
  routingMode: N8nRoutingModeName;
  fromDb: boolean;
}

function fromLegacy(value: LegacyN8nStored, source: 'LEGACY_SETTING' | 'ENV'): N8nConfig {
  const webhookBaseUrl = value.webhookBaseUrl?.trim() ?? '';
  const hmacSecret = readEncryptedSetting(value.hmacEncrypted, value.hmacSecret, 'n8n.hmacSecret');
  const apiKey = readEncryptedSetting(value.apiKeyEncrypted, value.apiKey, 'n8n.apiKey');
  const configured = Boolean(webhookBaseUrl && hmacSecret);
  return {
    ...DEFAULT_N8N_CONFIG,
    name: source === 'ENV' ? 'n8n (Umgebungsvariable)' : 'n8n (Legacy-Konfiguration)',
    kind: 'BUNDLED',
    routingMode: configured ? 'LEGACY' : 'DISABLED',
    enabled: configured,
    webhookBaseUrl,
    hmacSecret,
    apiBaseUrl: value.apiBaseUrl?.trim() ?? '',
    apiKey,
    source,
  };
}

export async function readN8nConfig(ctx: TenantContext): Promise<N8nConfig | null> {
  return withTenantContext(ctx, async (tx) => {
    const connection = await tx.n8nConnection.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    if (connection) {
      return {
        connectionId: connection.id,
        name: connection.name,
        kind: connection.kind,
        routingMode: connection.routingMode,
        enabled: connection.enabled,
        uiBaseUrl: connection.uiBaseUrl ?? '',
        callbackBaseUrl: connection.callbackBaseUrl ?? '',
        webhookBaseUrl: connection.webhookBaseUrl ?? '',
        hmacSecret: readEncryptedSetting(
          connection.signingSecretEncrypted,
          undefined,
          'n8n.signingSecret',
        ),
        apiBaseUrl: connection.apiBaseUrl ?? '',
        apiKey: readEncryptedSetting(connection.apiKeyEncrypted, undefined, 'n8n.apiKey'),
        callbackKeyId: connection.callbackKeyId,
        callbackConfigured: Boolean(connection.callbackTokenHash),
        callbackScopes: connection.callbackScopes,
        healthCheckedAt: connection.healthCheckedAt?.toISOString() ?? null,
        healthOk: connection.healthOk,
        healthError: connection.healthError,
        source: 'CONNECTION',
      };
    }

    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: LEGACY_KEY } },
      select: { value: true },
    });
    return row ? fromLegacy(row.value as LegacyN8nStored, 'LEGACY_SETTING') : null;
  });
}

/**
 * Erstellt/aktualisiert die Verbindung innerhalb einer bestehenden
 * Tenant-Transaktion. Dadurch können Konfigurationsänderung und Audit-Evidence
 * untrennbar gemeinsam committed werden.
 */
export async function writeN8nConfigTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  cfg: N8nConfig,
): Promise<string> {
  const connection = await tx.n8nConnection.upsert({
    where: { tenantId: ctx.tenantId },
    create: {
      tenantId: ctx.tenantId,
      name: cfg.name.trim() || 'TaxTronik n8n',
      kind: cfg.kind,
      routingMode: cfg.routingMode,
      enabled: cfg.enabled,
      uiBaseUrl: cfg.uiBaseUrl.trim() || null,
      callbackBaseUrl: cfg.callbackBaseUrl.trim().replace(/\/$/, '') || null,
      webhookBaseUrl: cfg.webhookBaseUrl.trim() || null,
      apiBaseUrl: cfg.apiBaseUrl.trim() || null,
      apiKeyEncrypted: cfg.apiKey ? encryptSecret(cfg.apiKey) : null,
      signingSecretEncrypted: cfg.hmacSecret ? encryptSecret(cfg.hmacSecret) : null,
    },
    update: {
      name: cfg.name.trim() || 'TaxTronik n8n',
      kind: cfg.kind,
      routingMode: cfg.routingMode,
      enabled: cfg.enabled,
      uiBaseUrl: cfg.uiBaseUrl.trim() || null,
      callbackBaseUrl: cfg.callbackBaseUrl.trim().replace(/\/$/, '') || null,
      webhookBaseUrl: cfg.webhookBaseUrl.trim() || null,
      apiBaseUrl: cfg.apiBaseUrl.trim() || null,
      apiKeyEncrypted: cfg.apiKey ? encryptSecret(cfg.apiKey) : null,
      signingSecretEncrypted: cfg.hmacSecret ? encryptSecret(cfg.hmacSecret) : null,
    },
    select: { id: true },
  });

  await tx.tenantSetting.deleteMany({
    where: { tenantId: ctx.tenantId, key: LEGACY_KEY },
  });
  return connection.id;
}

/** Erstellt/aktualisiert die Verbindung und migriert den alten Setting-Blob. */
export async function writeN8nConfig(ctx: TenantContext, cfg: N8nConfig): Promise<string> {
  return withTenantContext(ctx, (tx) => writeN8nConfigTx(tx, ctx, cfg));
}

export async function deleteN8nConfig(ctx: TenantContext): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.n8nConnection.deleteMany({ where: { tenantId: ctx.tenantId } });
    await tx.tenantSetting.deleteMany({ where: { tenantId: ctx.tenantId, key: LEGACY_KEY } });
  });
}

/** Effektive Konfiguration für serverseitige Legacy-Caller. */
export async function resolveN8nConfig(ctx: TenantContext): Promise<N8nConfig> {
  const db = await readN8nConfig(ctx);
  if (db) return db;
  return fromLegacy(
    {
      webhookBaseUrl: env.N8N_WEBHOOK_BASE_URL ?? '',
      hmacSecret: env.N8N_HMAC_SECRET ?? '',
    },
    'ENV',
  );
}

export async function getN8nStatus(ctx: TenantContext): Promise<N8nStatus> {
  const cfg = await resolveN8nConfig(ctx);
  return {
    webhookConfigured: Boolean(cfg.enabled && cfg.hmacSecret),
    apiConfigured: Boolean(cfg.apiBaseUrl && cfg.apiKey),
    callbackConfigured: cfg.callbackConfigured,
    routingMode: cfg.routingMode,
    fromDb: cfg.source !== 'ENV',
  };
}
