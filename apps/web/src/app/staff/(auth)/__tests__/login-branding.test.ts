import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// R-14: das Staff-Auth-Layout rendert den gemeinsamen AuthShell.
const layoutSource = readFileSync(
  new URL('../../../../components/auth-shell.tsx', import.meta.url),
  'utf8',
);
const loginSource = readFileSync(new URL('../login/page.tsx', import.meta.url), 'utf8');

describe('Whitelabel-Staff-Login', () => {
  it('zeigt Kanzlei-Branding und keine sichtbare TaxTronik-Wortmarke', () => {
    expect(layoutSource).toContain("readBrandingForSlug('default')");
    expect(layoutSource).toContain('<TenantLogo');
    expect(layoutSource).toContain('{branding.displayName}');
    expect(loginSource).toContain('>Mitarbeiter-Login</h1>');
    expect(loginSource).not.toContain('>TaxTronik</div>');
    expect(loginSource).toContain("a.download = 'mitarbeiter-login-backup-codes.txt'");
  });
});
