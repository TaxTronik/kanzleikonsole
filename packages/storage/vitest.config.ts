import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Wie apps/web und packages/config: In CI laufen alle Jobs parallel und
    // teilen sich die Runner-CPU; die Vitest-Vorgabe von 5 s riss dort Tests,
    // die allein rund 2 s brauchen (Lauf 1263/1267, 2026-11-20).
    testTimeout: 20_000,
    // Reine Unit-Tests für Aufbewahrungsfristen & Lock-Modus — kein S3-/Netz-Setup.
    pool: 'forks',
    // Keine Minimal-ENV: das Paket liest seine Konfiguration erst beim ersten
    // Zugriff (src/config.ts, K-09), nicht beim Import.
  },
});
