import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const loginPage = readFileSync(
  new URL('../../app/staff/(auth)/login/page.tsx', import.meta.url),
  'utf8',
);
const loginActions = readFileSync(
  new URL('../../app/staff/(auth)/login/actions.ts', import.meta.url),
  'utf8',
);
const rootLayout = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
const globalSearch = readFileSync(new URL('../global-search.tsx', import.meta.url), 'utf8');
const quantenlosPanel = readFileSync(
  new URL('../../app/staff/(protected)/admin/quantenlos/quantenlos-panel.tsx', import.meta.url),
  'utf8',
);

describe('Login-Navigation und Credential-Autofill', () => {
  it('schließt den erfolgreichen Login per validiertem Server-Redirect ab', () => {
    expect(loginActions).toContain("import { redirect } from 'next/navigation'");
    expect(loginActions).toContain("const returnTo = safeStaffReturnTo(formData.get('returnTo'))");
    expect(loginActions).toContain('redirect(returnTo)');
    expect(loginPage).toContain('name="returnTo" value={returnTo}');
    expect(loginPage).not.toContain('window.location.href = returnTo');
    expect(rootLayout).toMatch(/<script\s+nonce=\{nonce\}\s+suppressHydrationWarning/);
  });

  it('setzt die persistente globale Suche bei Seitenwechsel zurück', () => {
    expect(globalSearch).toContain('const pathname = usePathname()');
    expect(globalSearch).toContain('<GlobalSearchForPath key={pathname} navItems={navItems} />');
    expect(globalSearch).toContain('name="taxtronik-global-search"');
    expect(globalSearch).toContain('autoComplete="off"');
  });

  it('grenzt den IBM-Token von gespeicherten Login-Zugangsdaten ab', () => {
    expect(quantenlosPanel).toContain('<form');
    expect(quantenlosPanel).toContain('name="ibm-quantum-api-token"');
    expect(quantenlosPanel).toContain('autoComplete="new-password"');
    expect(quantenlosPanel).toContain('data-lpignore="true"');
    expect(quantenlosPanel).toContain('type="submit"');
  });
});
