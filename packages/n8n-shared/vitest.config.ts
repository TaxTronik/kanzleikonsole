import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests (HMAC-Signing, Event-Whitelist) — kein Netzwerk.
    pool: 'forks',
  },
});
