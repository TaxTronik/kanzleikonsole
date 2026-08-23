import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  staffSessionSubject: vi.fn(),
  staffSignOut: vi.fn(),
  revokeAllSessions: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({
  env: {
    STAFF_COOKIE_DOMAIN: undefined,
    NEXTAUTH_URL: 'https://staff.example.test',
  },
}));

vi.mock('@/server/auth/staff', () => ({
  staffSessionSubject: mocks.staffSessionSubject,
  staffSignOut: mocks.staffSignOut,
}));

vi.mock('@/server/auth/revocation', () => ({
  revokeAllSessions: mocks.revokeAllSessions,
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

function request(
  method: 'GET' | 'POST',
  fetchSite = 'same-origin',
  origin = 'https://staff.example.test',
): NextRequest {
  return new NextRequest('https://staff.example.test/api/staff/force-logout', {
    method,
    headers: {
      'sec-fetch-site': fetchSite,
      ...(method === 'POST' ? { origin } : {}),
      cookie: '__Host-taxtronik_staff_session.0=first; __Host-taxtronik_staff_session.1=second',
    },
  });
}

describe('GET/POST /api/staff/force-logout', () => {
  beforeEach(() => {
    mocks.staffSessionSubject.mockReset();
    mocks.staffSessionSubject.mockResolvedValue('staff-1');
    mocks.staffSignOut.mockReset();
    mocks.staffSignOut.mockResolvedValue(undefined);
    mocks.revokeAllSessions.mockReset();
    mocks.revokeAllSessions.mockResolvedValue(undefined);
  });

  it('meldet per POST ab, loescht Basis- und Chunk-Cookies und leitet relativ um', async () => {
    const response = await POST(request('POST'));

    expect(mocks.staffSignOut).toHaveBeenCalledWith({ redirect: false });
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', 'staff-1');
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

    const response = await POST(request('POST'));

    expect(response.status).toBe(303);
    expect(response.cookies.get('__Host-taxtronik_staff_session.0')?.value).toBe('');
  });

  it('behaelt GET fuer die Selbstheilung ungueltiger Sessions bei', async () => {
    mocks.staffSessionSubject.mockResolvedValueOnce(null);
    const response = await GET(request('GET'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/login');
    expect(response.cookies.get('__Host-taxtronik_staff_session')?.value).toBe('');
    expect(mocks.staffSessionSubject).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('meldet bei fehlgeschlagenem serverseitigem Widerruf keinen Erfolg', async () => {
    mocks.revokeAllSessions.mockRejectedValueOnce(new Error('redis down'));

    const response = await POST(request('POST'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'session_revocation_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.cookies.get('__Host-taxtronik_staff_session.0')?.value).toBe('');
    expect(mocks.staffSignOut).toHaveBeenCalledWith({ redirect: false });
  });

  it('veraendert bei einer Same-Site-Fremd-Origin keine Session', async () => {
    const response = await POST(request('POST', 'same-site', 'https://attacker.example.test'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'origin_mismatch' });
    expect(mocks.staffSessionSubject).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.staffSignOut).not.toHaveBeenCalled();
    expect(response.cookies.getAll()).toHaveLength(0);
  });
});
