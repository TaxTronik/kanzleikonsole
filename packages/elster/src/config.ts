// =============================================================================
// ELSTER-Bridge-Konfiguration — URL + Bearer-Token der eric-bridge.
//
// Single Source: `elsterConfig` aus @taxtronik/config (null, wenn die Bridge
// nicht deployt ist — sie ist opt-in). Gleiches Muster wie der Risk-Layer:
// wer den Client baut, muss die fehlende Konfiguration bewusst behandeln
// (try/catch oder vorher `isElsterConfigured` — UI blendet das Modul aus).
//
// Die Hersteller-ID taucht hier bewusst NICHT auf: sie ist ein Geheimnis und
// ausschließlich Konfiguration der Bridge selbst (eric-integration.md, Regel 4).
// =============================================================================

import { elsterConfig } from '@taxtronik/config';

export interface ElsterConfig {
  /** Basis-URL der Bridge, ohne Trailing-Slash (z. B. `http://eric-bridge:8085`). */
  url: string;
  /** Shared Secret für `Authorization: Bearer`. */
  token: string;
}

/**
 * Wird geworfen, wenn ein Bridge-Call versucht wird, obwohl ELSTER_BRIDGE_URL /
 * ELSTER_BRIDGE_TOKEN nicht gesetzt sind. Eigene Klasse, damit Caller den
 * „Bridge nicht konfiguriert“-Fall sauber vom Transport-/HTTP-Fehler trennen.
 */
export class ElsterNotConfiguredError extends Error {
  constructor() {
    super(
      'ELSTER-Bridge ist nicht konfiguriert — ELSTER_BRIDGE_URL und ' +
        'ELSTER_BRIDGE_TOKEN müssen gesetzt sein.',
    );
    this.name = 'ElsterNotConfiguredError';
  }
}

/** True, wenn die Bridge konfiguriert ist (für UI-/Feature-Gating). */
export function isElsterConfigured(): boolean {
  return elsterConfig !== null;
}

/** Liefert die Config oder wirft `ElsterNotConfiguredError`. */
export function requireElsterConfig(): ElsterConfig {
  if (!elsterConfig) throw new ElsterNotConfiguredError();
  return elsterConfig;
}
