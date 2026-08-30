import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../user-menu.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

describe('UserMenu Logout', () => {
  it('zentriert den Avatar auch innerhalb vergrößerter Klickflächen', () => {
    const button = styles.match(/\.avatar-btn\s*\{([^}]+)\}/)?.[1];
    expect(button).toContain('items-center');
    expect(button).toContain('justify-center');
    expect(button).toContain('shrink-0');
    const avatar = styles.match(/\.avatar\s*\{([^}]+)\}/)?.[1];
    expect(avatar).toContain('shrink-0');
  });
  it('sendet den Logout über ein Formular außerhalb des schließenden Dropdown-Portals', () => {
    expect(source).toContain('logoutFormRef.current?.requestSubmit()');
    expect(source).toContain('ref={logoutFormRef}');
    expect(source).toContain('action={logoutAction}');
    expect(source).toContain('method="post"');
    expect(source).not.toContain('<form action={logoutAction} method="post">');
  });
});
