import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const API_DIR = join(APP_DIR, 'api');
const MUTATING_EXPORT = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

const ALTERNATIVE_MUTATION_GUARDS: Record<string, string[]> = {
  // Auth.js-Endpunkte sind Framework-Routen mit eigener CSRF-/Callback-Logik.
  'api/auth/portal/[...nextauth]/route.ts': ['handlers'],
  'api/auth/staff/[...nextauth]/route.ts': ['handlers'],
  // Externe n8n-Webhooks sind nicht cookie-authentifiziert, sondern HMAC + Replay-Schutz.
  'api/n8n/[...path]/route.ts': ['verifyN8nSignature'],
  'api/n8n/request-inbound/route.ts': ['verifyN8nSignature'],
  'api/n8n/research-result/route.ts': ['verifyN8nSignature'],
  // Versionierte n8n-Callbacks sind ebenfalls nicht cookie-authentifiziert:
  // verbindungsgebundene Key-ID + Bearer-Token/Scope ersetzen CSRF, die
  // reservierte Request-ID verhindert Replay-Ausfuehrungen.
  'api/integrations/n8n/v1/request-inbound/route.ts': [
    'authenticateN8nCallback',
    'runReservedN8nCallback',
  ],
  'api/integrations/n8n/v1/research-result/route.ts': [
    'authenticateN8nCallback',
    'runReservedN8nCallback',
  ],
  // Logout muss auch bei defekter Session funktionieren; Fetch-Metadata blockt Cross-Site.
  'api/staff/force-logout/route.ts': ['sec-fetch-site', 'staffSignOut'],
};

const mutatingRoutes = walk(API_DIR)
  .map((file) => ({
    file,
    rel: relative(APP_DIR, file).replace(/\\/g, '/'),
    source: readFileSync(file, 'utf8'),
  }))
  .filter((r) => MUTATING_EXPORT.test(r.source));

describe('mutierende API-Routes haben CSRF- oder HMAC-Schutz', () => {
  it('findet mutierende API-Routen', () => {
    expect(mutatingRoutes.length).toBeGreaterThan(5);
  });

  for (const { rel, source } of mutatingRoutes) {
    it(`${rel}: nutzt assertSameOrigin oder dokumentierte Alternative`, () => {
      const alternatives = ALTERNATIVE_MUTATION_GUARDS[rel] ?? [];
      const hasSameOrigin = source.includes('assertSameOrigin');
      const hasAlternative =
        alternatives.length > 0 && alternatives.every((needle) => source.includes(needle));

      expect(
        hasSameOrigin || hasAlternative,
        `${rel} ist mutierend und braucht assertSameOrigin oder eine explizite HMAC/Auth.js/Fetch-Metadata-Ausnahme.`,
      ).toBe(true);
    });
  }
});
