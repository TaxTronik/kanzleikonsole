import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('token-bearing route referrer policies', () => {
  it('pins audit verification URLs to no-referrer', () => {
    const config = readFileSync(new URL('../../next.config.mjs', import.meta.url), 'utf8');
    expect(config).toMatch(
      /source:\s*['"]\/audit-verify\/:path\*['"][\s\S]*?Referrer-Policy['"],\s*value:\s*['"]no-referrer['"]/,
    );
  });

  it('rate-limits expensive public verification per IP and per signed token', () => {
    const page = readFileSync(
      new URL('../app/audit-verify/[token]/page.tsx', import.meta.url),
      'utf8',
    );
    // IP-Bucket über checkIpOrGlobalLimit: `getClientIp` liefert null, wenn
    // kein vertrauenswürdiger Proxy-Header vorliegt. Roh interpoliert ergäbe
    // das den gemeinsamen Schlüssel "…:null" und ein einzelner Spammer sperrte
    // die Verifikation für alle externen Prüfer.
    expect(page).toContain("checkIpOrGlobalLimit(\n    'audit-verify-ip',");
    expect(page).not.toMatch(/checkRateLimit\(`[^`]*\$\{ip\}/);
    // Token-Bucket bleibt ein direkter checkRateLimit — der Fingerprint ist
    // immer gesetzt, hier gibt es kein null-Problem.
    expect(page).toContain('audit-verify-token:');
    expect(page.match(/await checkRateLimit/g)).toHaveLength(1);
  });
});
