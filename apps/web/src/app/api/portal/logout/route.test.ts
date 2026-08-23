import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  portalSessionSubject: vi.fn(),
  portalSignOut: vi.fn(),
  revokeAllSessions: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({
  env: { PORTAL_COOKIE_DOMAIN: undefined },
  portalBaseUrl: 'https://portal.example.test',
}));

vi.mock('@/server/auth/portal', () => ({
  portalSessionSubject: mocks.portalSessionSubject,
  portalSignOut: mocks.portalSignOut,
}));

vi.mock('@/server/auth/revocation', () => ({
  revokeAllSessions: mocks.revokeAllSessions,
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

function request(fetchSite: string, origin = 'https://portal.example.test'): NextRequest {
  return new NextRequest('https://portal.example.test/api/portal/logout', {
    method: 'POST',
    headers: {
      'sec-fetch-site': fetchSite,
      origin,
      cookie: '__Host-taxtronik_portal_session.0=first; __Host-taxtronik_portal_session.1=second',
    },
  });
}

describe('POST /api/portal/logout', () => {
  beforeEach(() => {
    mocks.portalSessionSubject.mockReset();
    mocks.portalSessionSubject.mockResolvedValue('contact-1');
    mocks.portalSignOut.mockReset();
    mocks.portalSignOut.mockResolvedValue(undefined);
    mocks.revokeAllSessions.mockReset();
    mocks.revokeAllSessions.mockResolvedValue(undefined);
  });

  it('meldet ab, loescht alle Cookie-Varianten und leitet hosttreu um', async () => {
    const response = await POST(request('same-origin'));

    expect(mocks.portalSignOut).toHaveBeenCalledWith({ redirect: false });
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('portal', 'contact-1');
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

    const response = await POST(request('same-origin'));

    expect(response.status).toBe(303);
    expect(response.cookies.get('__taxtronik_portal_session')?.value).toBe('');
  });

  it('blockiert Cross-Site-POSTs vor dem Logout', async () => {
    const response = await POST(request('same-site', 'https://attacker.example.test'));

    expect(response.status).toBe(403);
    expect(mocks.portalSessionSubject).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.portalSignOut).not.toHaveBeenCalled();
  });

  it('meldet bei fehlgeschlagenem serverseitigem Widerruf keinen Erfolg', async () => {
    mocks.revokeAllSessions.mockRejectedValueOnce(new Error('redis down'));

    const response = await POST(request('same-origin'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'session_revocation_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.cookies.get('__Host-taxtronik_portal_session.0')?.value).toBe('');
    expect(mocks.portalSignOut).toHaveBeenCalledWith({ redirect: false });
  });
});
