import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests für Aufbewahrungsfristen & Lock-Modus — kein S3-/Netz-Setup.
    pool: 'forks',
    // Keine Minimal-ENV: das Paket liest seine Konfiguration erst beim ersten
    // Zugriff (src/config.ts, K-09), nicht beim Import.
  },
});
