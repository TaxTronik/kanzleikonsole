import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Wie apps/web und packages/config: In CI laufen alle Jobs parallel und
    // teilen sich die Runner-CPU; die Vitest-Vorgabe von 5 s riss dort Tests,
    // die allein rund 2 s brauchen (Lauf 1263/1267, 2026-11-20).
    testTimeout: 20_000,
    // Unit-Tests ohne Netz außer lokalen Testservern auf 127.0.0.1 und ohne
    // ENV: Konfiguration und Schlüssel entstehen im Test. Der Vertragstest
    // gegen eine laufende TCMS-API läuft nur über vitest.contract.config.ts.
    pool: 'forks',
    exclude: [...configDefaults.exclude, 'src/**/*.contract.test.ts'],
  },
});
