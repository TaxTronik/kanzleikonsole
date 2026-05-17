// =============================================================================
// Tenant-spezifische n8n-Bridge-Konfiguration
//
// Speichert URLs + Secrets der n8n-Instanz, die mit dieser Kanzlei verbunden
// ist. Liegt in `tenant_setting.integrations.n8n`. HMAC-Secret und API-Key
// werden mit `encryptSecret` verschlüsselt — beide sind kritisch (HMAC =
// Webhook-Auth zwischen App und n8n; API-Key = Voll-Lese-/Schreibzugriff auf
// alle n8n-Workflows).
//
// Wenn das tenant_setting fehlt, fällt jede Funktion auf die ENV-Werte zurück
// (Single-Tenant-On-Prem-Setup).
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { decryptSecret, encryptSecret, looksEncrypted } from '@/server/crypto/secret-box';
import { env } from '@taxtronik/config';

const KEY = 'integrations.n8n';

export interface N8nConfig {
  /** z. B. http://localhost:5678/webhook — Basis-URL für Outbound-Events */
  webhookBaseUrl: string;
  /** Geteiltes HMAC-Secret für Signaturen zwischen App und n8n */
  hmacSecret: string;
  /** z. B. http://localhost:5678/api/v1 — Basis-URL der REST-API */
  apiBaseUrl: string;
  /** n8n-API-Key (Settings → API in der n8n-UI generieren) */
  apiKey: string;
}

export const DEFAULT_N8N_CONFIG: N8nConfig = {
  webhookBaseUrl: '',
  hmacSecret: '',
  apiBaseUrl: '',
  apiKey: '',
};

interface N8nStored {
  webhookBaseUrl: string;
  hmacEncrypted: string;
  apiBaseUrl: string;
  apiKeyEncrypted: string;
}

export interface N8nStatus {
  /** True, wenn URL + Secret gepflegt sind (Outbound-Pfad funktioniert) */
  webhookConfigured: boolean;
  /** True, wenn REST-API-URL + Key gepflegt sind (Workflow-Verwaltung) */
  apiConfigured: boolean;
  /** True, wenn Werte aus tenant_setting kommen — sonst ENV-Fallback */
  fromDb: boolean;
}

export async function readN8nConfig(ctx: TenantContext): Promise<N8nConfig | null> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
    });
    if (!row) return null;
    const v = row.value as Partial<N8nStored> & { hmacSecret?: string; apiKey?: string };

    let hmac = '';
    if (v.hmacEncrypted && looksEncrypted(v.hmacEncrypted)) {
      try { hmac = decryptSecret(v.hmacEncrypted); } catch { hmac = ''; }
    } else if (typeof v.hmacSecret === 'string') {
      hmac = v.hmacSecret;
    }

    let apiKey = '';
    if (v.apiKeyEncrypted && looksEncrypted(v.apiKeyEncrypted)) {
      try { apiKey = decryptSecret(v.apiKeyEncrypted); } catch { apiKey = ''; }
    } else if (typeof v.apiKey === 'string') {
      apiKey = v.apiKey;
    }

    return {
      webhookBaseUrl: v.webhookBaseUrl ?? '',
      hmacSecret: hmac,
      apiBaseUrl: v.apiBaseUrl ?? '',
      apiKey,
    };
  });
}

export async function writeN8nConfig(ctx: TenantContext, cfg: N8nConfig): Promise<void> {
  const stored: N8nStored = {
    webhookBaseUrl: cfg.webhookBaseUrl.trim(),
    hmacEncrypted: cfg.hmacSecret ? encryptSecret(cfg.hmacSecret) : '',
    apiBaseUrl: cfg.apiBaseUrl.trim(),
    apiKeyEncrypted: cfg.apiKey ? encryptSecret(cfg.apiKey) : '',
  };
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY,
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}

export async function deleteN8nConfig(ctx: TenantContext): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.deleteMany({
      where: { tenantId: ctx.tenantId, key: KEY },
    });
  });
}

/**
 * Effektive Konfiguration: tenant_setting wenn da, sonst ENV-Fallback. Wird
 * von `emitN8nEvent` benutzt — kein UI-Schreibpfad.
 */
export async function resolveN8nConfig(ctx: TenantContext): Promise<N8nConfig> {
  const db = await readN8nConfig(ctx);
  if (db && (db.webhookBaseUrl || db.hmacSecret)) return db;
  // ENV-Fallback (Single-Tenant-On-Prem)
  return {
    webhookBaseUrl: env.N8N_WEBHOOK_BASE_URL ?? '',
    hmacSecret: env.N8N_HMAC_SECRET ?? '',
    apiBaseUrl: '',  // ENV hat keinen separaten API-Key, das geht nur über UI
    apiKey: '',
  };
}

export async function getN8nStatus(ctx: TenantContext): Promise<N8nStatus> {
  const row = await withTenantContext(ctx, (tx) =>
    tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      select: { value: true },
    }),
  );
  if (row) {
    const v = row.value as Partial<N8nStored>;
    return {
      webhookConfigured: Boolean(v.webhookBaseUrl && v.hmacEncrypted),
      apiConfigured: Boolean(v.apiBaseUrl && v.apiKeyEncrypted),
      fromDb: true,
    };
  }
  return {
    webhookConfigured: Boolean(env.N8N_WEBHOOK_BASE_URL && env.N8N_HMAC_SECRET),
    apiConfigured: false,
    fromDb: false,
  };
}
