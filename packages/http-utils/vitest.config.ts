import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests der SSRF-Policy (IP-Klassifikation, Literal-IP-/
    // Allowlist-Pfade) — kein DNS, kein Netzwerk.
    pool: 'forks',
  },
});
