import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  staffSignOut: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({
  env: { STAFF_COOKIE_DOMAIN: undefined },
}));

vi.mock('@/server/auth/staff', () => ({
  staffSignOut: mocks.staffSignOut,
}));

vi.mock('@/server/auth/session-cookie', () => ({
  STAFF_SESSION_COOKIE_BASE: 'taxtronik_staff_session',
  USE_SECURE_COOKIES: true,
  sessionCookieNameVariants: () => [
    '__taxtronik_staff_session',
    '__Host-taxtronik_staff_session',
    '__Secure-taxtronik_staff_session',
  ],
}));

import { GET, POST } from './route';

function request(method: 'GET' | 'POST', fetchSite = 'same-origin'): NextRequest {
  return new NextRequest('https://0.0.0.0:3000/api/staff/force-logout', {
    method,
    headers: {
      'sec-fetch-site': fetchSite,
      cookie: '__Host-taxtronik_staff_session.0=first; __Host-taxtronik_staff_session.1=second',
    },
  });
}

describe('GET/POST /api/staff/force-logout', () => {
  beforeEach(() => {
    mocks.staffSignOut.mockReset();
    mocks.staffSignOut.mockResolvedValue(undefined);
  });

  it('meldet per POST ab, loescht Basis- und Chunk-Cookies und leitet relativ um', async () => {
    const response = await POST(request('POST'));

    expect(mocks.staffSignOut).toHaveBeenCalledWith({ redirect: false });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/login');
    expect(response.headers.get('location')).not.toContain('0.0.0.0');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.cookies.get('__taxtronik_staff_session')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_staff_session')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_staff_session')?.secure).toBe(true);
    expect(response.cookies.get('__Secure-taxtronik_staff_session')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_staff_session.0')?.value).toBe('');
    expect(response.cookies.get('__Host-taxtronik_staff_session.1')?.value).toBe('');
  });

  it('loescht die Cookies auch dann, wenn Auth.js beim Logout scheitert', async () => {
    mocks.staffSignOut.mockRejectedValueOnce(new Error('auth unavailable'));

    const response = await POST(request('POST', 'same-site'));

    expect(response.status).toBe(303);
    expect(response.cookies.get('__Host-taxtronik_staff_session.0')?.value).toBe('');
  });

  it('behaelt GET fuer die Selbstheilung ungueltiger Sessions bei', async () => {
    const response = await GET(request('GET'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/login');
    expect(response.cookies.get('__Host-taxtronik_staff_session')?.value).toBe('');
  });

  it('veraendert bei Cross-Site-Navigationen keine Session', async () => {
    const response = await POST(request('POST', 'cross-site'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/login');
    expect(mocks.staffSignOut).not.toHaveBeenCalled();
    expect(response.cookies.getAll()).toHaveLength(0);
  });
});
