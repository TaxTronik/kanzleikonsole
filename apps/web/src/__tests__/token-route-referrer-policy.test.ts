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
    expect(page).toContain('audit-verify-ip:');
    expect(page).toContain('audit-verify-token:');
    expect(page.match(/await checkRateLimit/g)).toHaveLength(2);
  });
});
