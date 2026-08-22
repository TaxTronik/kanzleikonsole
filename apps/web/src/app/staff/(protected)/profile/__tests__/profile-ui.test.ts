import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const profileSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const formSource = readFileSync(new URL('../password-form.tsx', import.meta.url), 'utf8');
const layoutSource = readFileSync(new URL('../../layout.tsx', import.meta.url), 'utf8');

describe('staff user profile UI', () => {
  it('is reachable beside logout for every protected staff session', () => {
    expect(layoutSource).toContain('href="/staff/profile"');
    expect(layoutSource).toContain('Benutzerprofil');
  });

  it('collects current, new and confirmation passwords without displaying them', () => {
    expect(formSource.match(/type="password"/g)).toHaveLength(3);
    expect(formSource).toContain('name="currentPassword"');
    expect(formSource).toContain('name="newPassword"');
    expect(formSource).toContain('name="confirmPassword"');
    expect(formSource).toContain("window.location.assign('/api/staff/force-logout')");
  });

  it('shows current 2FA state and the recovery path', () => {
    expect(profileSource).toContain('Zwei-Faktor-Authentisierung');
    expect(profileSource).toContain('kann ein Admin die 2FA-Zuordnung');
  });
});
