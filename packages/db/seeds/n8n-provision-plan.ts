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

export interface ManagedN8nProvisionedConnection {
  kind: 'BUNDLED' | 'SELF_HOSTED' | 'CLOUD';
  apiBaseUrl: string | null;
  webhookBaseUrl: string | null;
}

export interface ManagedN8nProvisionedEndpoint {
  source: 'MANAGED' | 'DISCOVERED' | 'CUSTOM' | 'LEGACY';
  productionUrl: string;
  testUrl: string | null;
}

export type ManagedN8nProvisionRepair = Partial<
  Pick<ManagedN8nProvisionPlan, 'apiBaseUrl' | 'webhookBaseUrl'>
>;

export type ManagedN8nEndpointRepair = Partial<
  Pick<ManagedN8nProvisionedEndpoint, 'productionUrl' | 'testUrl'>
>;

const LEGACY_COMPOSE_API_BASE_URL = 'http://n8n:5678/api/v1';
const LEGACY_COMPOSE_WEBHOOK_BASE_URL = 'http://n8n:5678/webhook';

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
    // Das ACP zeigt und speichert dieselben öffentlichen Adressen, die n8n
    // selbst hinter dem Reverse-Proxy veröffentlicht. Der Compose-Service
    // `n8n:5678` ist ausschließlich ein Infrastruktur-Upstream und darf nicht
    // als Public API oder als Basis erkannter Workflow-Routen erscheinen.
    apiBaseUrl: new URL('/api/v1', publicUrl).toString().replace(/\/$/, ''),
    webhookBaseUrl: new URL('/webhook', publicUrl).toString().replace(/\/$/, ''),
    callbackBaseUrl: 'http://app:3000',
  };
}

/**
 * Repariert ausschließlich die beiden früher automatisch gesetzten internen
 * Compose-Adressen. Manuell gepflegte und externe Verbindungen bleiben bei
 * Updates unangetastet.
 */
export function buildManagedN8nProvisionRepair(
  plan: ManagedN8nProvisionPlan,
  connection: ManagedN8nProvisionedConnection,
): ManagedN8nProvisionRepair | null {
  if (connection.kind !== 'BUNDLED') return null;

  const repair: ManagedN8nProvisionRepair = {};
  if (connection.apiBaseUrl === LEGACY_COMPOSE_API_BASE_URL) {
    repair.apiBaseUrl = plan.apiBaseUrl;
  }
  if (connection.webhookBaseUrl === LEGACY_COMPOSE_WEBHOOK_BASE_URL) {
    repair.webhookBaseUrl = plan.webhookBaseUrl;
  }
  return Object.keys(repair).length > 0 ? repair : null;
}

function publicUrlForLegacyComposeTarget(
  plan: ManagedN8nProvisionPlan,
  value: string | null,
): string | null {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== 'http://n8n:5678') return value;
    if (!/^\/webhook(?:-test)?(?:\/|$)/i.test(parsed.pathname)) return value;
    const publicOrigin = new URL(plan.uiBaseUrl).origin;
    return `${publicOrigin}${parsed.pathname}${parsed.search}`;
  } catch {
    return value;
  }
}

/** Repariert auch bereits aus dem alten internen Präfix erkannte Routen. */
export function buildManagedN8nEndpointRepair(
  plan: ManagedN8nProvisionPlan,
  endpoint: ManagedN8nProvisionedEndpoint,
): ManagedN8nEndpointRepair | null {
  if (endpoint.source !== 'MANAGED' && endpoint.source !== 'DISCOVERED') return null;

  const productionUrl = publicUrlForLegacyComposeTarget(plan, endpoint.productionUrl);
  const testUrl = publicUrlForLegacyComposeTarget(plan, endpoint.testUrl);
  const repair: ManagedN8nEndpointRepair = {};
  if (productionUrl !== endpoint.productionUrl && productionUrl) {
    repair.productionUrl = productionUrl;
  }
  if (testUrl !== endpoint.testUrl) repair.testUrl = testUrl;
  return Object.keys(repair).length > 0 ? repair : null;
}
