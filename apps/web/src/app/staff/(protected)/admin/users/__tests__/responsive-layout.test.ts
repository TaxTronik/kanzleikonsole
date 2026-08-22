import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const rowFormsSource = readFileSync(new URL('../row-forms.tsx', import.meta.url), 'utf8');

describe('users admin responsive layout', () => {
  it('does not require a horizontal table scroller', () => {
    expect(pageSource).not.toContain('overflow-x-auto');
    expect(pageSource).not.toContain('min-w-[64rem]');
    expect(pageSource).toContain('xl:table-fixed');
  });

  it('stacks rows as cards below the desktop breakpoint', () => {
    expect(pageSource).toContain('sm:grid-cols-2 xl:table-row');
    expect(pageSource).toContain('xl:hidden');
  });

  it('allows role and permission controls to wrap within their cells', () => {
    expect(rowFormsSource).toContain('flex min-w-0 flex-wrap items-center gap-2');
    expect(rowFormsSource).toContain('flex min-w-0 flex-wrap gap-1');
  });

  it('uses the wide layout for explicit account-security controls', () => {
    expect(pageSource).toContain('max-w-[112rem]');
    expect(pageSource).toContain('Kontosicherheit');
    expect(pageSource).toContain('<AccountSecurityForm');
    expect(rowFormsSource).toContain('Passwort setzen');
    expect(rowFormsSource).toContain('2FA zurücksetzen');
  });
});
