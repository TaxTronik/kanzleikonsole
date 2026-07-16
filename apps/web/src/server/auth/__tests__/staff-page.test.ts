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
});
