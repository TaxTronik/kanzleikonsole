// =============================================================================
// Risk-Layer-Konfiguration — URL, Bearer- und Operator-Token der §4-Engine.
//
// Single Source: der Risk-Layer-Teil des ENV-Schemas (@taxtronik/config/env-schema;
// null, wenn die Engine nicht deployt ist — sie ist opt-in). Gelesen wird erst
// beim Aufruf, nicht beim Import: das Paket lässt sich ohne Prozess-ENV laden
// und testen (K-09). Dieser Helper macht das `null` zu einem expliziten,
// typsicheren Vertrag: wer den Client baut, muss die fehlende Konfiguration
// bewusst behandeln (try/catch oder vorher `isRiskLayerConfigured`).
// =============================================================================

import { getRiskLayerConfig, type RiskLayerConfig } from '@taxtronik/config/env-schema';

export type { RiskLayerConfig } from '@taxtronik/config/env-schema';

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
  return getRiskLayerConfig() !== null;
}

/** Liefert die Config oder wirft `RiskLayerNotConfiguredError`. */
export function requireRiskLayerConfig(): RiskLayerConfig {
  const config = getRiskLayerConfig();
  if (!config) throw new RiskLayerNotConfiguredError();
  return config;
}
