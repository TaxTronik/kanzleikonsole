// =============================================================================
// Struktur-Guardrail: geschuetzte API-Routes muessen das passende Auth-Primitiv
// referenzieren. UI-/Server-Action-Tests reichen nicht fuer direkte API-Zugriffe:
// eine neue route.ts unter /api/staff oder /api/portal darf nicht versehentlich
// ohne staffAuth/portalAuth entstehen.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

const protectedRouteFiles = walk(join(APP_DIR, 'api')).filter((file) => {
  const rel = relative(APP_DIR, file).replace(/\\/g, '/');
  return rel.startsWith('api/staff/') || rel.startsWith('api/portal/');
});

const ALTERNATIVE_AUTH: Record<string, string[]> = {
  // Token-gated Kalenderfeed fuer externe Kalender-Apps. verifyIcalToken()
  // ist hier das Auth-Primitive; eine Session waere fuer ICS-Abos ungeeignet.
  'api/portal/ical/[token]/route.ts': ['verifyIcalToken'],
  // Selbstheilungs-Logout: loescht Staff-Cookies via Auth.js und blockt
  // cross-site Navigations ueber Sec-Fetch-Site, statt eine Session zu lesen.
  'api/staff/force-logout/route.ts': ['staffSignOut', 'sec-fetch-site'],
};

describe('geschuetzte API-Routes sind autorisiert (Struktur-Guardrail)', () => {
  it('findet die Staff-/Portal-API-Route-Flaeche', () => {
    expect(protectedRouteFiles.length).toBeGreaterThan(20);
  });

  for (const file of protectedRouteFiles) {
    const rel = relative(APP_DIR, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const expectedPrimitive = rel.startsWith('api/staff/') ? 'staffAuth' : 'portalAuth';
    const alternatives = ALTERNATIVE_AUTH[rel] ?? [];

    it(`${rel}: referenziert ${expectedPrimitive} oder dokumentierte Alternative`, () => {
      const hasExpected = source.includes(expectedPrimitive);
      const hasAlternative =
        alternatives.length > 0 && alternatives.every((a) => source.includes(a));
      expect(
        hasExpected || hasAlternative,
        `${rel} muss ${expectedPrimitive} oder eine explizit dokumentierte Alternative nutzen.`,
      ).toBe(true);
    });
  }
});
