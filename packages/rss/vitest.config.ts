import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests des Parsers (parseRss/Entity-Decoding) — der Fetcher
    // (safeFetch) wird hier NICHT angefasst, kein Netzwerk.
    pool: 'forks',
  },
});
