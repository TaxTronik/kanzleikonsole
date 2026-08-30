import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layoutSource = readFileSync(new URL('../layout.tsx', import.meta.url), 'utf8');
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
