import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests für ENV-Validierung — kein DB-/Netzwerk-Setup nötig.
    pool: 'forks',
    // Wie apps/web: env-profile-entries prüft alle Einstiege und brauchte in CI
    // (parallele Jobs auf einem Host) über 4 s; 20 s beenden Hänger trotzdem.
    testTimeout: 20_000,
  },
});
