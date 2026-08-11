// =============================================================================
// Risk-Layer-Konfiguration — URL, Bearer- und Operator-Token der §4-Engine.
//
// Single Source: `riskLayerConfig` aus @taxtronik/config (null, wenn die Engine
// nicht deployt ist — sie ist opt-in). Dieser Helper macht das `null` zu einem
// expliziten, typsicheren Vertrag: wer den Client baut, muss die fehlende
// Konfiguration bewusst behandeln (try/catch oder vorher `isRiskLayerConfigured`).
// =============================================================================

import { riskLayerConfig, type RiskLayerConfig } from '@taxtronik/config';

export type { RiskLayerConfig } from '@taxtronik/config';

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
        'RISK_LAYER_TOKEN müssen gesetzt sein.',
    );
    this.name = 'RiskLayerNotConfiguredError';
  }
}

/**
 * Wird nur bei Operator-Calls geworfen, wenn das getrennte Operator-Secret
 * fehlt. Read-only-Engine-Calls bleiben mit der normalen Basisconfig nutzbar.
 */
export class RiskLayerOperatorNotConfiguredError extends Error {
  constructor() {
    super(
      'Risk-Layer-Operatorzugriff ist nicht konfiguriert — ' +
        'RISK_LAYER_OPERATOR_TOKEN muss gesetzt sein.',
    );
    this.name = 'RiskLayerOperatorNotConfiguredError';
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
