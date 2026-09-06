// Fachkatalog: ACCESS-TENANT-RLS-001
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof import('react')>();
  return {
    ...original,
    // Render the actual second login step without starting an authentication.
    useState: <T,>(initial: T | (() => T)) =>
      original.useState(initial === 'password' ? ('totp' as T) : initial),
  };
});
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('../actions', () => ({
  beginHardwareLoginAction: vi.fn(),
  checkPasswordAction: vi.fn(),
  confirmTotpEnrollmentAction: vi.fn(),
  hardwareLoginAvailabilityAction: vi.fn(),
  loginAction: vi.fn(),
  loginHardwareAction: vi.fn(),
}));

import StaffLoginPage from '../page';

function codeInput() {
  const markup = renderToStaticMarkup(<StaffLoginPage />);
  const input = markup.match(/<input\b[^>]*\bid="totpCode"[^>]*>/)?.[0];
  expect(input).toBeDefined();
  const pattern = input!.match(/\bpattern="([^"]*)"/i)?.[1];
  const maxLength = Number(input!.match(/\bmaxLength="(\d+)"/i)?.[1]);
  expect(pattern).toBeDefined();
  return { markup, input: input!, pattern: new RegExp(`^(?:${pattern})$`, 'v'), maxLength };
}

describe('reguläre TOTP- und Recovery-Code-Eingabe', () => {
  it.each(['123456', '23456789AB', 'ABCDEFGHJK'])(
    'kann einen vollständigen unterstützten Code eingeben und absenden: %s',
    (code) => {
      const { pattern, maxLength } = codeInput();
      expect(maxLength).toBeGreaterThanOrEqual(code.length);
      expect(pattern.test(code)).toBe(true);
    },
  );

  it.each(['12345', '1234567', 'ABCDEFGHJ', 'ABCDEFGHJKM', 'abcdefghjk', 'ABCDEF0123'])(
    'weist unvollständige oder ungültige Formate weiterhin zurück: %s',
    (code) => {
      expect(codeInput().pattern.test(code)).toBe(false);
    },
  );

  it('erklärt beide Anmeldewege und ermöglicht Buchstaben auf Mobilgeräten', () => {
    const { markup, input } = codeInput();
    expect(markup).toContain('TOTP-Code oder Recovery-Code');
    expect(input).toContain('inputMode="text"');
    expect(input).toContain('name="totpCode"');
    expect(input).toContain('autoComplete="one-time-code"');
  });
});
