import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  portalSignOut: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({
  env: { PORTAL_COOKIE_DOMAIN: undefined },
}));

vi.mock('@/server/auth/portal', () => ({
  portalSignOut: mocks.portalSignOut,
}));

vi.mock('@/server/auth/session-cookie', () => ({
  PORTAL_SESSION_COOKIE_BASE: 'taxtronik_portal_session',
  USE_SECURE_COOKIES: true,
  sessionCookieNameVariants: () => [
    '__taxtronik_portal_session',
    '__Host-taxtronik_portal_session',
    '__Secure-taxtronik_portal_session',
  ],
}));

import { POST } from './route';

function request(fetchSite: string): NextRequest {
  return new NextRequest('https://portal.example.test/api/portal/logout', {
    method: 'POST',
    headers: {
      'sec-fetch-site': fetchSite,
      cookie: '__Host-taxtronik_portal_session.0=first; __Host-taxtronik_portal_session.1=second',
    },
  });
}

describe('POST /api/portal/logout', () => {
  beforeEach(() => {
    mocks.portalSignOut.mockReset();
    mocks.portalSignOut.mockResolvedValue(undefined);
  });

  it('meldet ab, loescht alle Cookie-Varianten und leitet hosttreu um', async () => {
    const response = await POST(request('same-origin'));

    expect(mocks.portalSignOut).toHaveBeenCalledWith({ redirect: false });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/portal/login');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.cookies.get('__taxtronik_portal_session')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_portal_session')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_portal_session')?.secure).toBe(true);
    expect(response.cookies.get('__Secure-taxtronik_portal_session')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_portal_session.0')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_portal_session.1')?.value).toBe('');
  });

  it('loescht die Cookies auch dann, wenn Auth.js beim Logout scheitert', async () => {
    mocks.portalSignOut.mockRejectedValueOnce(new Error('auth unavailable'));

    const response = await POST(request('same-site'));

    expect(response.status).toBe(303);
    expect(response.cookies.get('__taxtronik_portal_session')?.value).toBe('');
  });

  it('blockiert Cross-Site-POSTs vor dem Logout', async () => {
    const response = await POST(request('cross-site'));

    expect(response.status).toBe(403);
    expect(mocks.portalSignOut).not.toHaveBeenCalled();
  });
});
