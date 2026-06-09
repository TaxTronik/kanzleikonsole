import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests (AES-GCM-Roundtrip, v1/v2-Format, HKDF-Domain-Trennung)
    // — @taxtronik/config wird gemockt, kein ENV-Setup nötig.
    pool: 'forks',
  },
});
