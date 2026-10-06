// =============================================================================
// Risk-Layer-Konfiguration zur Aufrufzeit (Review-Befund K-09).
//
// Das Paket liest RISK_LAYER_* erst beim Aufruf aus der Prozess-ENV, nicht beim
// Import. Es lädt daher ohne Minimal-ENV (kein setup-env.ts) und prüft das
// Operator-Secret wie die Boot-Validierung von Web und Worker.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import {
  isRiskLayerConfigured,
  requireRiskLayerConfig,
  RiskLayerNotConfiguredError,
} from '../config';

const TOKEN = 't'.repeat(32);
const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('Risk-Layer-Konfiguration', () => {
  it('folgt der Prozess-ENV zum Zeitpunkt des Aufrufs', () => {
    process.env = {};
    expect(isRiskLayerConfigured()).toBe(false);
    expect(() => requireRiskLayerConfig()).toThrow(RiskLayerNotConfiguredError);

    process.env = { RISK_LAYER_URL: 'http://risk-layer:8000/', RISK_LAYER_TOKEN: TOKEN };
    expect(isRiskLayerConfigured()).toBe(true);
    expect(requireRiskLayerConfig()).toEqual({ url: 'http://risk-layer:8000', token: TOKEN });
  });

  it('verwirft ein Operator-Secret ohne Basiskonfiguration', () => {
    process.env = { RISK_LAYER_OPERATOR_TOKEN: 'o'.repeat(32) };
    expect(() => isRiskLayerConfigured()).toThrow(
      /^\[config\] RISK_LAYER_OPERATOR_TOKEN gesetzt, aber die Risk-Layer-Basiskonfiguration/,
    );
  });
});
