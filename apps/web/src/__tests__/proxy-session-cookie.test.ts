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
  it('uses a fresh nonce instead of unsafe-inline for production scripts', async () => {
    const { proxy } = await loadProxy({
      NODE_ENV: 'production',
      NEXTAUTH_URL: 'https://staff.example.test',
      PORTAL_PUBLIC_URL: undefined,
    });

    const first = proxy(request('https://staff.example.test/', ''));
    const second = proxy(request('https://staff.example.test/', ''));
    const firstCsp = first.headers.get('content-security-policy') ?? '';
    const secondCsp = second.headers.get('content-security-policy') ?? '';
    const firstScriptSrc = firstCsp.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? '';
    const secondScriptSrc = secondCsp.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? '';

    expect(firstScriptSrc).toContain("'strict-dynamic'");
    expect(firstScriptSrc).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/);
    expect(firstScriptSrc).not.toContain("'unsafe-inline'");
    expect(firstScriptSrc).not.toContain("'unsafe-eval'");
    expect(secondScriptSrc).not.toBe(firstScriptSrc);
  });

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

describe('proxy legacy n8n gate', () => {
  it.each([undefined, 'false', 'TRUE', '1'])(
    'hides every legacy path and method unless the flag is exact true (%s)',
    async (flag) => {
      const { proxy } = await loadProxy({
        NODE_ENV: 'test',
        N8N_LEGACY_CALLBACKS_ENABLED: flag,
      });

      const response = proxy(
        new NextRequest('https://staff.example.test/api/n8n/unknown-handler', {
          method: 'OPTIONS',
        }),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.text()).resolves.toBe('');
    },
  );

  it('forwards legacy paths only with explicit true so the HMAC handler can authenticate', async () => {
    const { proxy } = await loadProxy({
      NODE_ENV: 'test',
      N8N_LEGACY_CALLBACKS_ENABLED: 'true',
    });

    const response = proxy(new NextRequest('https://staff.example.test/api/n8n/overdue-requests'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
