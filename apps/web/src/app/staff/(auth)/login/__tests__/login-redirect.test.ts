// Erfolgreicher Staff-Login endet mit einem validierten Server-Redirect in
// derselben Action-Antwort (Verhaltenstest statt Quelltextprüfung, B-08,
// Welle 15). Ein clientseitiges window.location danach ließ die globale
// Error-Boundary aufblitzen.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffSignIn: vi.fn(),
  redirect: vi.fn((href: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${href}`), { digest: `NEXT_REDIRECT;${href}` });
  }),
  checkIpOrGlobalLimit: vi.fn(async () => ({ ok: true })),
  resetRateLimit: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'x-forwarded-for': '203.0.113.7' })),
}));
vi.mock('next-auth', () => ({ AuthError: class AuthError extends Error {} }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'test-auth-secret' } }));
vi.mock('@/server/auth/totp', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffSignIn: m.staffSignIn, DEV_SKIP_TOTP: false }));
vi.mock('@/server/auth/lockout', () => ({ resetFailedLogin: vi.fn() }));
vi.mock('@/server/auth/staff-password', () => ({ passwordAuthenticationBlocked: vi.fn() }));
vi.mock('@/server/auth/staff-login', () => ({}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/auth/webauthn', () => ({}));
vi.mock('@/server/rate-limit', () => ({
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  checkRateLimit: vi.fn(),
  getClientIp: () => '203.0.113.7',
  resetRateLimit: m.resetRateLimit,
  staffPasswordAccountRateLimitKey: vi.fn(),
}));

import { AuthError } from 'next-auth';
import { loginAction } from '../actions';

function form(returnTo: string | null): FormData {
  const data = new FormData();
  data.set('loginTicket', 'ticket-1');
  data.set('totpCode', '123456');
  if (returnTo !== null) data.set('returnTo', returnTo);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffSignIn.mockResolvedValue(undefined);
});

describe('loginAction', () => {
  it('meldet an und leitet serverseitig auf das validierte Ziel weiter', async () => {
    await expect(loginAction(form('/staff/clients?view=list'))).rejects.toThrow(
      'NEXT_REDIRECT:/staff/clients?view=list',
    );
    expect(m.staffSignIn).toHaveBeenCalledWith('credentials', {
      loginTicket: 'ticket-1',
      totpCode: '123456',
      redirect: false,
    });
    expect(m.redirect).toHaveBeenCalledOnce();
  });

  it.each([null, '//evil.example/x', 'https://evil.example', '/portal/dashboard', '/staff\\..\\x'])(
    'fällt bei ungültigem Ziel %s auf das Dashboard zurück',
    async (returnTo) => {
      await expect(loginAction(form(returnTo))).rejects.toThrow('NEXT_REDIRECT:/staff/dashboard');
    },
  );

  it('leitet bei ungültigen Anmeldedaten nicht weiter', async () => {
    m.staffSignIn.mockRejectedValueOnce(new AuthError('invalid'));
    await expect(loginAction(form('/staff/clients'))).resolves.toEqual({
      ok: false,
      error: 'Ungültige Anmeldedaten oder Code.',
    });
    expect(m.redirect).not.toHaveBeenCalled();
  });
});
