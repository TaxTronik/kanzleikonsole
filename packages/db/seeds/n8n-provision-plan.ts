export interface ManagedN8nProvisionEnv {
  N8N_HOST?: string | undefined;
  N8N_WEBHOOK_URL?: string | undefined;
  TENANT_SLUG?: string | undefined;
}

export interface ManagedN8nProvisionPlan {
  tenantSlug: string;
  uiBaseUrl: string;
  apiBaseUrl: string;
  webhookBaseUrl: string;
  callbackBaseUrl: string;
}

/**
 * Erstellt die sicheren ACP-Defaults für die von TaxTronik betriebene
 * Compose-Instanz. Kein N8N_HOST bedeutet bewusst: keine verwaltete Instanz,
 * also auch keine automatische Tenant-Konfiguration.
 */
export function buildManagedN8nProvisionPlan(
  env: ManagedN8nProvisionEnv,
): ManagedN8nProvisionPlan | null {
  const host = env.N8N_HOST?.trim().toLowerCase() ?? '';
  if (!host) return null;

  const publicUrl = new URL(env.N8N_WEBHOOK_URL?.trim() || `https://${host}/`);
  if (publicUrl.protocol !== 'https:') {
    throw new Error('Die öffentliche n8n-Adresse muss HTTPS verwenden.');
  }
  if (publicUrl.hostname.toLowerCase() !== host) {
    throw new Error('N8N_WEBHOOK_URL und N8N_HOST zeigen auf unterschiedliche Hosts.');
  }

  return {
    tenantSlug: env.TENANT_SLUG?.trim().toLowerCase() || 'default',
    uiBaseUrl: publicUrl.origin,
    // App und n8n teilen im verwalteten Setup dasselbe Compose-Netz. Die
    // interne Route umgeht unnötige DNS-/TLS-Hairpins und bleibt per SSRF-
    // Allowlist ausdrücklich auf den Service-Namen `n8n` begrenzt.
    apiBaseUrl: 'http://n8n:5678/api/v1',
    webhookBaseUrl: 'http://n8n:5678/webhook',
    callbackBaseUrl: 'http://app:3000',
  };
}
