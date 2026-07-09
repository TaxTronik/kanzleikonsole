// =============================================================================
// Regressionstest: Verbindungs-Optionen des Redis-Singletons.
//
// Hintergrund (Prod-Bug): `enableOfflineQueue: false` + `lazyConnect: true`
// führte dazu, dass das ALLERERSTE Kommando mit „Stream isn't writeable"
// abgelehnt wurde, während der Socket noch verband. Der Rate-Limiter wertete das
// als Redis-Exception und lieferte in Produktion fail-closed `retryAfter: 60`
// → der erste Login nach jedem Prozessstart schlug mit „Zu viele Versuche.
// Bitte 1 Min. warten." fehl; der sofortige zweite Versuch klappte.
//
// Der Fail-Fast bei einem ECHTEN Ausfall darf dabei NICHT verloren gehen — dafür
// sorgen maxRetriesPerRequest + commandTimeout, nicht die Offline-Queue.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('@taxtronik/config', () => ({
  env: { REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'test' },
}));

import { REDIS_OPTIONS } from '../redis';

describe('REDIS_OPTIONS', () => {
  it('Offline-Queue AKTIV — überbrückt das (Re-)Connect-Fenster', () => {
    // Kern des Bugfixes: mit `false` wird das erste Kommando verworfen.
    expect(REDIS_OPTIONS.enableOfflineQueue).toBe(true);
  });

  it('Fail-Fast bei echtem Ausfall bleibt erhalten', () => {
    // Begrenzte Retries: bei totem Redis bricht das Kommando in ~60 ms ab,
    // statt über den Ausfall hinweg zu queuen.
    expect(REDIS_OPTIONS.maxRetriesPerRequest).toBe(1);
    // Backstop gegen verbundene, aber hängende Redis-Instanz.
    expect(REDIS_OPTIONS.commandTimeout).toBeGreaterThan(0);
    expect(REDIS_OPTIONS.commandTimeout).toBeLessThanOrEqual(5_000);
  });

  it('lazyConnect: kein Verbindungsaufbau beim Modul-Import/Build', () => {
    expect(REDIS_OPTIONS.lazyConnect).toBe(true);
  });
});
