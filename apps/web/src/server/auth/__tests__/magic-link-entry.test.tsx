// Fachkatalog: ACCESS-TENANT-RLS-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({
  limit: vi.fn(),
  ip: vi.fn(),
  verify: vi.fn(),
  inspect: vi.fn(),
  writeSession: vi.fn(),
  redirect: vi.fn(),
  config: null as unknown as { providers: unknown[] },
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/server/auth/magic-link', () => ({
  requestMagicLink: vi.fn(),
  verifyMagicLink: h.verify,
  inspectMagicLink: h.inspect,
}));
vi.mock('@/server/auth/portal-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/auth/portal-session')>()),
  writePortalSession: h.writeSession,
}));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: h.ip,
  checkIpOrGlobalLimit: h.limit,
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'test-secret', NODE_ENV: 'test' } }));
vi.mock('@/server/auth/revocation', () => ({ isTokenRevoked: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('next-auth', () => ({
  default: (config: typeof h.config) => {
    h.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import { confirmMagicLinkAction, verifyMagicLinkAction } from '@/app/portal/(auth)/login/actions';
import VerifyMagicLinkPage from '@/app/portal/(auth)/login/verify/page';
import '../portal';

const contact = {
  id: 'contact-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  fullName: 'Portal Contact',
  email: 'portal@example.test',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ip.mockReturnValue('203.0.113.12');
  h.limit.mockResolvedValue({ ok: true, remaining: 9, retryAfter: 0 });
  h.verify.mockResolvedValue({ contact });
  h.writeSession.mockResolvedValue(undefined);
  h.inspect.mockResolvedValue({
    profiles: [{ contactId: contact.id, contactName: contact.fullName, clientName: 'Mandat A' }],
  });
});

describe('ACCESS-TENANT-RLS-001: public magic-link ingress', () => {
  // S-05: Der frühere Auth.js-Credentials-Provider war ein zweiter, ungenutzter
  // Login-Pfad. Einziger Einstieg ist jetzt die Bestätigungs-Action.
  it('accepts magic links only through the confirmation action, not through Auth.js', async () => {
    expect(h.config.providers).toEqual([]);
    await expect(verifyMagicLinkAction('token', contact.id)).resolves.toEqual({ ok: true });
    expect(h.limit.mock.calls).toEqual([
      ['portal-authorize', '203.0.113.12', { max: 10, windowSec: 600 }],
    ]);
    expect(h.writeSession).toHaveBeenCalledExactlyOnceWith(contact);
    expect(h.verify).toHaveBeenCalledExactlyOnceWith('token', contact.id);
  });

  it('blocks the POST ingress before token lookup, consumption or cookie creation', async () => {
    h.limit.mockResolvedValue({ ok: false, retryAfter: 60 });
    await expect(verifyMagicLinkAction('token', contact.id)).resolves.toMatchObject({
      ok: false,
      rateLimited: true,
    });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.writeSession).not.toHaveBeenCalled();
  });

  it('limits GET inspection separately and never consumes a link while rendering profiles', async () => {
    const page = await VerifyMagicLinkPage({ searchParams: Promise.resolve({ token: 'token' }) });
    expect(renderToStaticMarkup(page)).toContain('Mandat A');
    expect(h.limit).toHaveBeenCalledExactlyOnceWith('portal-inspect', '203.0.113.12', {
      max: 30,
      windowSec: 600,
    });
    expect(h.inspect).toHaveBeenCalledExactlyOnceWith('token');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.writeSession).not.toHaveBeenCalled();
  });

  it('does not inspect a token when the GET quota is exhausted and explains retrying', async () => {
    h.limit.mockResolvedValue({ ok: false, retryAfter: 60 });
    const page = await VerifyMagicLinkPage({ searchParams: Promise.resolve({ token: 'token' }) });
    expect(renderToStaticMarkup(page)).toContain('Zu viele Aufrufe');
    expect(h.inspect).not.toHaveBeenCalled();
  });

  it('falls back to the storm ceiling without a trusted IP and preserves explicit profile selection', async () => {
    h.ip.mockReturnValue(null);
    const form = new FormData();
    form.set('token', 'token');
    form.set('contactId', contact.id);
    form.set('returnTo', '/portal/requests');
    await confirmMagicLinkAction(form);
    expect(h.limit).toHaveBeenCalledWith('portal-authorize', null, { max: 10, windowSec: 600 });
    expect(h.verify).toHaveBeenCalledWith('token', contact.id);
    expect(h.redirect).toHaveBeenCalledExactlyOnceWith('/portal/requests');
  });

  it('does not report a rate-limited confirmation as an invalid or consumed link', async () => {
    h.limit.mockResolvedValue({ ok: false, retryAfter: 60 });
    const form = new FormData();
    form.set('token', 'token');
    await confirmMagicLinkAction(form);
    expect(h.redirect).toHaveBeenCalledExactlyOnceWith('/portal/login/verify?status=rate-limited');
    const page = await VerifyMagicLinkPage({
      searchParams: Promise.resolve({ status: 'rate-limited' }),
    });
    expect(renderToStaticMarkup(page)).toContain('ursprünglichen Login-Link erneut');
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
});
