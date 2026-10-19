import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit-Tests ohne Netz außer lokalen Testservern auf 127.0.0.1 und ohne
    // ENV: Konfiguration und Schlüssel entstehen im Test. Der Vertragstest
    // gegen eine laufende TCMS-API läuft nur über vitest.contract.config.ts.
    pool: 'forks',
    exclude: [...configDefaults.exclude, 'src/**/*.contract.test.ts'],
  },
});
