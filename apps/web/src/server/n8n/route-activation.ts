export interface N8nConnectionRouteState {
  enabled: boolean;
  routingMode: 'DISABLED' | 'LEGACY' | 'EXPLICIT';
}

export interface N8nConnectionRoutePatch {
  enabled?: true;
  routingMode?: 'EXPLICIT';
}

/**
 * Das bewusste Aktivieren einer Einzelroute ist zugleich die Freigabe der
 * n8n-Integration für explizites Routing. Andernfalls könnte das ACP eine
 * Route als „aktiv“ anzeigen, während der globale, vom One-Click-Provisioning
 * zunächst deaktivierte Connection-Schalter jede Zustellung weiterhin
 * blockiert.
 */
export function connectionPatchForSavedRoute(params: {
  connection: N8nConnectionRouteState;
  routeEnabledRequested: boolean;
}): N8nConnectionRoutePatch {
  if (params.routeEnabledRequested) {
    return { enabled: true, routingMode: 'EXPLICIT' };
  }
  if (params.connection.enabled && params.connection.routingMode !== 'DISABLED') {
    return { routingMode: 'EXPLICIT' };
  }
  return {};
}
