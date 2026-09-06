// Fachkatalog: PAYROLL-INTAKE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  withContext: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  rate: vi.fn(),
  entryRate: vi.fn(),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: mocks.withContext }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.get, set: mocks.set, delete: mocks.delete }),
  headers: async () => new Headers(),
}));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => null,
  checkRateLimit: mocks.rate,
  checkIpOrGlobalLimit: mocks.entryRate,
}));
import {
  EMPTY_PAYROLL_CONTEXT,
  PAYROLL_COOKIE,
  guardPayrollEmployee,
  guardPayrollEmployeeEntry,
  guardPayrollEmployeeLogout,
  tokenHash,
} from '../capability';
const token = 'ab'.repeat(32);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.withContext.mockImplementation(async (_ctx, fn) =>
    fn({ $queryRaw: mocks.query, $executeRaw: mocks.execute }),
  );
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.entryRate.mockResolvedValue({ ok: true });
  mocks.get.mockReturnValue({ value: token });
});
describe('PAYROLL-INTAKE-001 canonical narrow employee guards', () => {
  it('rejects malformed or rate-limited invitations before database or cookie writes', async () => {
    expect(await guardPayrollEmployeeEntry('not-an-invite')).toBe(false);
    mocks.entryRate.mockResolvedValue({ ok: false });
    expect(await guardPayrollEmployeeEntry(token)).toBe(false);
    expect(mocks.withContext).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('creates only the separate scoped cookie after a successful one-time exchange in an empty context', async () => {
    const expires = new Date('2026-08-31T20:00:00Z');
    mocks.query.mockResolvedValue([{ expiry: expires }]);
    expect(await guardPayrollEmployeeEntry(token)).toBe(true);
    expect(mocks.withContext).toHaveBeenCalledWith(EMPTY_PAYROLL_CONTEXT, expect.any(Function));
    expect(EMPTY_PAYROLL_CONTEXT).toEqual({
      tenantId: '00000000-0000-0000-0000-000000000000',
      actorId: null,
      actorType: 'STAFF',
    });
    const call = mocks.query.mock.calls[0]!;
    expect(call[1]).toBe(tokenHash(token));
    expect(call[1]).not.toBe(token);
    expect(mocks.set).toHaveBeenCalledWith(
      PAYROLL_COOKIE,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.objectContaining({
        path: '/payroll/employee',
        sameSite: 'strict',
        httpOnly: true,
        expires,
      }),
    );
  });
  it('does not accept a syntactically valid cookie after the live database scope was revoked', async () => {
    mocks.query.mockResolvedValue([{ data: null }]);
    await expect(guardPayrollEmployee()).rejects.toThrow('widerrufen');
    expect(mocks.withContext).toHaveBeenCalledWith(EMPTY_PAYROLL_CONTEXT, expect.any(Function));
  });
  it('logs out using a void-safe narrow RPC and removes only the employee cookie', async () => {
    await guardPayrollEmployeeLogout();
    expect(mocks.execute).toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls[0]![1]).toBe(tokenHash(token));
    expect(mocks.delete).toHaveBeenCalledWith({ name: PAYROLL_COOKIE, path: '/payroll/employee' });
  });
});
