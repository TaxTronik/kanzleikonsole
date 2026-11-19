import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  isStaffAdmin: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`redirect:${target}`);
  }),
}));

vi.mock('../staff', () => ({ staffAuth: mocks.staffAuth }));
vi.mock('../rbac', () => ({ isStaffAdmin: mocks.isStaffAdmin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { requireStaffPage } from '../staff-page';

describe('requireStaffPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects anonymous requests to the staff login', async () => {
    mocks.staffAuth.mockResolvedValue(null);
    await expect(requireStaffPage()).rejects.toThrow('redirect:/staff/login');
  });

  it('returns an authenticated staff session', async () => {
    const session = { user: { roles: ['STAFF'] } };
    mocks.staffAuth.mockResolvedValue(session);
    await expect(requireStaffPage()).resolves.toBe(session);
  });

  it('centralizes the admin/partner redirect', async () => {
    mocks.staffAuth.mockResolvedValue({ user: { roles: ['STAFF'] } });
    mocks.isStaffAdmin.mockReturnValue(false);
    await expect(requireStaffPage({ admin: true })).rejects.toThrow('redirect:/staff/dashboard');
  });

  it('redirects non-admins to an internal deniedRedirect path', async () => {
    mocks.staffAuth.mockResolvedValue({ user: { roles: ['STAFF'] } });
    mocks.isStaffAdmin.mockReturnValue(false);
    await expect(requireStaffPage({ admin: true, deniedRedirect: '/staff/poa' })).rejects.toThrow(
      'redirect:/staff/poa',
    );
  });

  it.each([
    'https://evil.example/staff/poa',
    '//evil.example',
    '/\\evil.example',
    '/staff//evil.example',
    '/staff/../..//evil.example',
    '/staff/poa?next=https://evil.example',
    '/staff/poa#x',
    '/staff',
    '/portal/dashboard',
    'javascript:alert(1)',
  ])('rejects the off-surface deniedRedirect %s before any redirect', async (target) => {
    mocks.staffAuth.mockResolvedValue({ user: { roles: ['STAFF'] } });
    mocks.isStaffAdmin.mockReturnValue(false);
    await expect(
      requireStaffPage({
        admin: true,
        deniedRedirect: target as `/staff/${string}`,
      }),
    ).rejects.toThrow('deniedRedirect muss ein Pfad unter /staff/ sein');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.staffAuth).not.toHaveBeenCalled();
  });
});
