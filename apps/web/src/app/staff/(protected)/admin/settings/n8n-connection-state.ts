export interface N8nConnectionState {
  name: string;
  kind: 'BUNDLED' | 'SELF_HOSTED' | 'CLOUD';
  routingMode: 'DISABLED' | 'LEGACY' | 'EXPLICIT';
  enabled: boolean;
  uiBaseUrl: string;
  callbackBaseUrl: string;
  webhookBaseUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  keepApiKey: boolean;
  hmacSecret: string;
  keepHmac: boolean;
}

interface N8nConnectionInitialConfig {
  name: N8nConnectionState['name'];
  kind: N8nConnectionState['kind'];
  routingMode: N8nConnectionState['routingMode'];
  enabled: N8nConnectionState['enabled'];
  uiBaseUrl: N8nConnectionState['uiBaseUrl'];
  callbackBaseUrl: N8nConnectionState['callbackBaseUrl'];
  webhookBaseUrl: N8nConnectionState['webhookBaseUrl'];
  apiBaseUrl: N8nConnectionState['apiBaseUrl'];
  hasApiKey: boolean;
  hasSigningSecret: boolean;
}

export type N8nConnectionAction =
  | { type: 'patch'; value: Partial<N8nConnectionState> }
  | { type: 'generated-signing-secret'; secret: string }
  | { type: 'saved' };

export function createN8nConnectionState(initial: N8nConnectionInitialConfig): N8nConnectionState {
  return {
    name: initial.name,
    kind: initial.kind,
    routingMode: initial.routingMode,
    enabled: initial.enabled,
    uiBaseUrl: initial.uiBaseUrl,
    callbackBaseUrl: initial.callbackBaseUrl,
    webhookBaseUrl: initial.webhookBaseUrl,
    apiBaseUrl: initial.apiBaseUrl,
    apiKey: '',
    keepApiKey: initial.hasApiKey,
    hmacSecret: '',
    keepHmac: initial.hasSigningSecret,
  };
}

export function n8nConnectionReducer(
  state: N8nConnectionState,
  action: N8nConnectionAction,
): N8nConnectionState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.value };
    case 'generated-signing-secret':
      return { ...state, hmacSecret: action.secret, keepHmac: false };
    case 'saved':
      return {
        ...state,
        apiKey: '',
        hmacSecret: '',
        keepApiKey: true,
        keepHmac: true,
      };
  }
}
