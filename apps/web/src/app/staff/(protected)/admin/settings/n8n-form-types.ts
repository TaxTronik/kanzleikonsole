export interface N8nBrowserConfig {
  connectionId: string | null;
  name: string;
  kind: 'BUNDLED' | 'SELF_HOSTED' | 'CLOUD';
  routingMode: 'DISABLED' | 'LEGACY' | 'EXPLICIT';
  enabled: boolean;
  uiBaseUrl: string;
  callbackBaseUrl: string;
  webhookBaseUrl: string;
  apiBaseUrl: string;
  hasSigningSecret: boolean;
  hasApiKey: boolean;
  callbackKeyId: string;
  callbackConfigured: boolean;
  callbackScopes: string[];
  healthCheckedAt: string | null;
  healthOk: boolean | null;
  healthError: string | null;
  source: 'CONNECTION' | 'LEGACY_SETTING' | 'ENV';
}

export interface BundledWorkflowSummary {
  templateId: string;
  version: number;
  name: string;
  description: string;
  events: string[];
  callbackScopes: string[];
  credentials: Array<{ name: string; n8nType: string; source: string }>;
  prerequisites: string[];
}

export interface SetupStep {
  label: string;
  done: boolean;
}
