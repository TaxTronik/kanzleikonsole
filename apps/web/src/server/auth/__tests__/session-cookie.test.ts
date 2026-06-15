import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadCookieNames(env: NodeJS.ProcessEnv) {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  return import('../session-cookie');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('session cookie names', () => {
  it('uses secure prefixes in production', async () => {
    const cookies = await loadCookieNames({
      NODE_ENV: 'production',
      CI: undefined,
      DEV_SKIP_TOTP: undefined,
      E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION: undefined,
      NEXTAUTH_URL: 'https://staff.example.test',
      STAFF_COOKIE_DOMAIN: undefined,
      PORTAL_COOKIE_DOMAIN: 'portal.example.test',
    });

    expect(cookies.STAFF_SESSION_COOKIE).toBe('__Host-taxtronik_staff_session');
    expect(cookies.PORTAL_SESSION_COOKIE).toBe('__Secure-taxtronik_portal_session');
  });

  it('does not use secure prefixes for local HTTP CI E2E runs', async () => {
    const cookies = await loadCookieNames({
      NODE_ENV: 'production',
      CI: 'true',
      DEV_SKIP_TOTP: 'true',
      E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION: 'true',
      NEXTAUTH_URL: 'http://localhost:3000',
      STAFF_COOKIE_DOMAIN: undefined,
      PORTAL_COOKIE_DOMAIN: undefined,
    });

    expect(cookies.STAFF_SESSION_COOKIE).toBe('__taxtronik_staff_session');
    expect(cookies.PORTAL_SESSION_COOKIE).toBe('__taxtronik_portal_session');
  });
});
