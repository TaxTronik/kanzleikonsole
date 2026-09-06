// Fachkatalog: ACCESS-TENANT-RLS-001, CLIENT-MANDATE-LIFECYCLE-001.
// Real profile action, profile resolver, encrypted cookies and auth validation;
// only request/DB/Redis boundaries are simulated, including deliberate races.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cookie: '',
  cutoffs: new Map<string, string>(),
  contacts: [] as Array<{
    id: string;
    tenantId: string;
    clientId: string;
    email: string;
    fullName: string;
    active: boolean;
    client: { name: string; allowActive: boolean; anonymizedAt: null; mandateEndedAt: null };
  }>,
  onTransaction: () => {},
  record: vi.fn(),
  update: vi.fn(),
}));
vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => ({ value: h.cookie }),
    getAll: () => [],
    set: (_name: string, value: string) => {
      h.cookie = value;
    },
  }),
}));
vi.mock('next-auth', () => ({
  default: () => ({ handlers: {}, signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'portal-profile-local-fixture-secret-32characters',
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXTAUTH_TRUST_HOST: true,
    NODE_ENV: 'test',
  },
}));
vi.mock('../magic-link', () => ({ verifyMagicLink: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: vi.fn(), checkIpOrGlobalLimit: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({ get: async (key: string) => h.cutoffs.get(key) ?? null }),
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    clientContact: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        h.contacts.find((c) => c.id === where.id) ?? null,
    },
  },
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.onTransaction();
    const matches = (
      contact: (typeof h.contacts)[number],
      where: { id?: string; tenantId?: string; email?: string },
    ) =>
      (!where.id || contact.id === where.id) &&
      (!where.tenantId || contact.tenantId === where.tenantId) &&
      (!where.email || contact.email === where.email) &&
      contact.active &&
      contact.client.allowActive;
    return fn({
      clientContact: {
        findFirst: async ({
          where,
        }: {
          where: { id?: string; tenantId?: string; email?: string };
        }) => h.contacts.find((c) => matches(c, where)) ?? null,
        findMany: async ({ where }: { where: { tenantId: string; email: string } }) =>
          h.contacts.filter((c) => matches(c, where)),
        update: h.update,
      },
    });
  },
}));

import { portalAuth, portalSessionSubject } from '../portal';
import { writePortalSession } from '../portal-session';
import { switchPortalProfileAction } from '@/app/portal/(protected)/profile-actions';

const NOW = new Date('2026-09-06T12:00:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const VICTIM = '33333333-3333-4333-8333-333333333333';

async function login(id = A) {
  await writePortalSession(h.contacts.find((c) => c.id === id)!);
}
async function switchTo(id: string) {
  const data = new FormData();
  data.set('contactId', id);
  await expect(switchPortalProfileAction(data)).rejects.toThrow(/^REDIRECT:/);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW.getTime() - 60_000));
  h.cutoffs.clear();
  h.onTransaction = () => {};
  h.contacts = [A, B, VICTIM].map((id) => ({
    id,
    tenantId: 'tenant',
    clientId: `client-${id}`,
    fullName: `Contact ${id}`,
    active: true,
    email: id === VICTIM ? 'victim@example.test' : 'verified@example.test',
    client: { name: `Client ${id}`, allowActive: true, anonymizedAt: null, mandateEndedAt: null },
  }));
  await login();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('Portal profile switch retains its authenticated identity', () => {
  it('cannot bypass an existing target cutoff without another Magic-Link login', async () => {
    h.cutoffs.set(`revoke:portal:${B}`, String(NOW.getTime() - 30_000));
    await switchTo(B);
    expect((await portalAuth())?.user.contactId).not.toBe(B);
    // A new proof of mailbox access after the cutoff can still log in.
    await login(B);
    expect((await portalAuth())?.user.contactId).toBe(B);
  });

  it('does not adopt another mailbox if the source email changes after authentication', async () => {
    h.onTransaction = () => {
      h.contacts[0]!.email = 'victim@example.test';
    };
    await switchTo(VICTIM);
    expect(await portalAuth()).toBeNull();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('does not survive revocation of the login contact racing with the profile switch', async () => {
    h.onTransaction = () => {
      h.cutoffs.set(`revoke:portal:${A}`, String(NOW.getTime()));
    };
    await switchTo(B);
    expect(await portalAuth()).toBeNull();
  });

  it('retains the original login time and contact over repeated valid switches', async () => {
    await switchTo(B);
    expect((await portalAuth())?.user.contactId).toBe(B);
    expect(await portalSessionSubject()).toBe(A);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await switchTo(A);
    expect((await portalAuth())?.user.contactId).toBe(A);
    h.cutoffs.set(`revoke:portal:${A}`, String(NOW.getTime() - 30_000));
    expect(await portalAuth()).toBeNull();
  });

  it('invalidates derived sessions when the verified login mailbox changes', async () => {
    await switchTo(B);
    h.contacts[0]!.email = 'new-owner@example.test';
    expect(await portalAuth()).toBeNull();
  });

  it('invalidates derived sessions when the original login contact is deactivated', async () => {
    await switchTo(B);
    h.contacts[0]!.active = false;
    expect(await portalAuth()).toBeNull();
  });
});
