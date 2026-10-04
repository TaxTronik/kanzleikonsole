// Fachkatalog: ACCESS-CLIENT-MODE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // React.cache memoisiert nur im RSC-Renderer (react-server-Build) pro Request;
  // in Vitest ist es ein Durchreicher. Nachbildung: memoisiert pro Argumentliste,
  // bis `newRequest()` den Request-Scope verwirft.
  const scopes = new Set<Map<string, unknown>>();
  return {
    requireStaffPage: vi.fn(),
    canAccessClient: vi.fn(),
    redirect: vi.fn((target: string) => {
      throw new Error(`redirect:${target}`);
    }),
    cache<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
      const memo = new Map<string, unknown>();
      scopes.add(memo);
      return (...args: A): R => {
        const key = JSON.stringify(args);
        if (!memo.has(key)) memo.set(key, fn(...args));
        return memo.get(key) as R;
      };
    },
    newRequest() {
      for (const memo of scopes) memo.clear();
    },
  };
});

vi.mock('react', () => ({ cache: mocks.cache }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../staff-page', () => ({ requireStaffPage: mocks.requireStaffPage }));
vi.mock('../rbac', () => ({ canAccessClient: mocks.canAccessClient }));

import { requireClientPageAccess } from '../client-page-access';

const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] } };

describe('requireClientPageAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.newRequest();
    mocks.requireStaffPage.mockResolvedValue(session);
  });

  it('liefert bei erlaubtem Zugriff die Session', async () => {
    mocks.canAccessClient.mockResolvedValue(true);

    await expect(requireClientPageAccess('client-1')).resolves.toBe(session);
    expect(mocks.canAccessClient).toHaveBeenCalledWith(session, 'client-1');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('leitet bei verweigertem Zugriff wie bisher das Layout auf die Mandantenliste um', async () => {
    mocks.canAccessClient.mockResolvedValue(false);

    await expect(requireClientPageAccess('client-1')).rejects.toThrow(
      'redirect:/staff/clients?denied=1',
    );
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it('prüft ohne Staff-Session keinen Mandanten', async () => {
    mocks.requireStaffPage.mockRejectedValue(new Error('redirect:/staff/login'));

    await expect(requireClientPageAccess('client-1')).rejects.toThrow('redirect:/staff/login');
    expect(mocks.canAccessClient).not.toHaveBeenCalled();
  });

  it('prüft pro Request und Mandant nur einmal, auch wenn Layout und Seite parallel rufen', async () => {
    mocks.canAccessClient.mockResolvedValue(true);

    const [layout, page] = await Promise.all([
      requireClientPageAccess('client-1'),
      requireClientPageAccess('client-1'),
    ]);
    expect(layout).toBe(session);
    expect(page).toBe(session);
    expect(mocks.requireStaffPage).toHaveBeenCalledTimes(1);
    expect(mocks.canAccessClient).toHaveBeenCalledTimes(1);

    await requireClientPageAccess('client-2');
    expect(mocks.canAccessClient).toHaveBeenCalledTimes(2);
    expect(mocks.canAccessClient).toHaveBeenLastCalledWith(session, 'client-2');

    mocks.newRequest();
    await requireClientPageAccess('client-1');
    expect(mocks.canAccessClient).toHaveBeenCalledTimes(3);
  });

  it('liefert auch die Verweigerung allen Aufrufern desselben Requests', async () => {
    mocks.canAccessClient.mockResolvedValue(false);

    await expect(requireClientPageAccess('client-1')).rejects.toThrow(
      'redirect:/staff/clients?denied=1',
    );
    await expect(requireClientPageAccess('client-1')).rejects.toThrow(
      'redirect:/staff/clients?denied=1',
    );
    expect(mocks.canAccessClient).toHaveBeenCalledTimes(1);
  });
});
