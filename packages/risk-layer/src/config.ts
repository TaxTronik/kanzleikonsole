// =============================================================================
// Risk-Layer-Konfiguration — URL + Bearer-Token der §4-Engine.
//
// Single Source: `riskLayerConfig` aus @taxtronik/config (null, wenn die Engine
// nicht deployt ist — sie ist opt-in). Dieser Helper macht das `null` zu einem
// expliziten, typsicheren Vertrag: wer den Client baut, muss die fehlende
// Konfiguration bewusst behandeln (try/catch oder vorher `isRiskLayerConfigured`).
// =============================================================================

import { riskLayerConfig } from '@taxtronik/config';

export interface RiskLayerConfig {
  /** Basis-URL der Engine, ohne Trailing-Slash (z. B. `http://risk-layer:8000`). */
  url: string;
  /** Shared Secret für `Authorization: Bearer`. */
  token: string;
}

/**
 * Wird geworfen, wenn ein Engine-Call versucht wird, obwohl RISK_LAYER_URL /
 * RISK_LAYER_TOKEN nicht gesetzt sind. Eigene Klasse, damit Caller den
 * „Engine nicht konfiguriert"-Fall sauber vom Transport-/HTTP-Fehler trennen
 * (z. B. UI: Modul ausblenden statt Fehler anzeigen).
 */
export class RiskLayerNotConfiguredError extends Error {
  constructor() {
    super(
      'Risk-Layer-Engine ist nicht konfiguriert — RISK_LAYER_URL und ' +
        'RISK_LAYER_TOKEN müssen gesetzt sein (und der Host in INTERNAL_FETCH_HOSTS).',
    );
    this.name = 'RiskLayerNotConfiguredError';
  }
}

/** True, wenn die Engine konfiguriert ist (für UI-/Feature-Gating). */
export function isRiskLayerConfigured(): boolean {
  return riskLayerConfig !== null;
}

/** Liefert die Config oder wirft `RiskLayerNotConfiguredError`. */
export function requireRiskLayerConfig(): RiskLayerConfig {
  if (!riskLayerConfig) throw new RiskLayerNotConfiguredError();
  return riskLayerConfig;
}
