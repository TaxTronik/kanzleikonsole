import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../user-menu.tsx', import.meta.url), 'utf8');

describe('UserMenu Logout', () => {
  it('sendet den Logout über ein Formular außerhalb des schließenden Dropdown-Portals', () => {
    expect(source).toContain('logoutFormRef.current?.requestSubmit()');
    expect(source).toContain('ref={logoutFormRef}');
    expect(source).toContain('action={logoutAction}');
    expect(source).toContain('method="post"');
    expect(source).not.toContain('<form action={logoutAction} method="post">');
  });
});
