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
  /** Persistierter Status; der Secret-Inhalt bleibt ausschließlich serverseitig. */
  hasSigningSecret: boolean;
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
    hasSigningSecret: initial.hasSigningSecret,
    keepHmac: initial.hasSigningSecret,
  };
}

/**
 * FormData der Verbindung aus dem kontrollierten Zustand — dieselben Felder,
 * die das Formular selbst trägt (sichtbare Inputs plus Hidden-Felder für
 * Routing-Modus und Keep-Flags). Speichern und „API testen“ senden damit
 * genau den angezeigten Stand.
 */
export function n8nConnectionFormData(state: N8nConnectionState): FormData {
  const data = new FormData();
  data.set('name', state.name);
  data.set('kind', state.kind);
  data.set('routingMode', state.routingMode);
  if (state.enabled && state.routingMode !== 'DISABLED') data.set('enabled', 'on');
  data.set('uiBaseUrl', state.uiBaseUrl);
  data.set('callbackBaseUrl', state.callbackBaseUrl);
  data.set('webhookBaseUrl', state.webhookBaseUrl);
  data.set('apiBaseUrl', state.apiBaseUrl);
  data.set('apiKey', state.apiKey);
  data.set('hmacSecret', state.hmacSecret);
  if (state.keepApiKey) data.set('keepApiKey', 'on');
  if (state.keepHmac) data.set('keepHmac', 'on');
  return data;
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
    case 'saved': {
      const hasSigningSecret = Boolean(
        state.hmacSecret || (state.hasSigningSecret && state.keepHmac),
      );
      return {
        ...state,
        apiKey: '',
        hmacSecret: '',
        keepApiKey: true,
        hasSigningSecret,
        keepHmac: hasSigningSecret,
      };
    }
  }
}
