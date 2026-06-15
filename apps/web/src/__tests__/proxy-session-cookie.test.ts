import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_ENV = { ...process.env };

async function loadProxy(env: NodeJS.ProcessEnv) {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  return import('../proxy');
}

function request(url: string, cookie: string): NextRequest {
  return new NextRequest(url, { headers: { cookie } });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('proxy session cookie gate', () => {
  it('accepts the local HTTP staff cookie variant during localhost E2E', async () => {
    const { proxy } = await loadProxy({
      NODE_ENV: 'production',
      NEXTAUTH_URL: 'https://staff.example.test',
      PORTAL_PUBLIC_URL: undefined,
      CI: undefined,
      DEV_SKIP_TOTP: undefined,
      E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION: undefined,
      E2E_BASE_URL: undefined,
    });

    const response = proxy(
      request('http://localhost:3000/staff/dashboard', '__taxtronik_staff_session=token'),
    );

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('does not accept an unprefixed staff cookie on production HTTPS requests', async () => {
    const { proxy } = await loadProxy({
      NODE_ENV: 'production',
      NEXTAUTH_URL: 'https://staff.example.test',
      PORTAL_PUBLIC_URL: undefined,
      CI: undefined,
      DEV_SKIP_TOTP: undefined,
      E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION: undefined,
      E2E_BASE_URL: undefined,
    });

    const response = proxy(
      request('https://staff.example.test/staff/dashboard', '__taxtronik_staff_session=token'),
    );

    const location = response.headers.get('location');
    expect(location).toContain('/staff/login');
    expect(location).toContain('returnTo=%2Fstaff%2Fdashboard');
  });

  it('accepts the configured secure staff cookie on production HTTPS requests', async () => {
    const { proxy } = await loadProxy({
      NODE_ENV: 'production',
      NEXTAUTH_URL: 'https://staff.example.test',
      PORTAL_PUBLIC_URL: undefined,
      CI: undefined,
      DEV_SKIP_TOTP: undefined,
      E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION: undefined,
      E2E_BASE_URL: undefined,
    });

    const response = proxy(
      request('https://staff.example.test/staff/dashboard', '__Host-taxtronik_staff_session=token'),
    );

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
