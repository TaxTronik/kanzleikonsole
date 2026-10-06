// =============================================================================
// ELSTER-Bridge-Konfiguration zur Aufrufzeit (Review-Befund K-09).
//
// Das Paket liest ELSTER_BRIDGE_* erst beim Aufruf aus der Prozess-ENV, nicht
// beim Import. Es lädt daher ohne Minimal-ENV (kein setup-env.ts).
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { ElsterNotConfiguredError, isElsterConfigured, requireElsterConfig } from '../config';

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('ELSTER-Bridge-Konfiguration', () => {
  it('folgt der Prozess-ENV zum Zeitpunkt des Aufrufs', () => {
    process.env = { ELSTER_BRIDGE_URL: 'http://eric-bridge:8085/' };
    expect(isElsterConfigured()).toBe(false);
    expect(() => requireElsterConfig()).toThrow(ElsterNotConfiguredError);

    process.env = {
      ELSTER_BRIDGE_URL: 'http://eric-bridge:8085/',
      ELSTER_BRIDGE_TOKEN: 'e'.repeat(16),
    };
    expect(isElsterConfigured()).toBe(true);
    expect(requireElsterConfig()).toEqual({
      url: 'http://eric-bridge:8085',
      token: 'e'.repeat(16),
    });
  });
});
