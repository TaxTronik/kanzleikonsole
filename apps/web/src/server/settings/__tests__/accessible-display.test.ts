import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  staffFindFirst: vi.fn(),
  contactFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}));

import { readAccessibleDisplay, readAccessibleDisplayOptions } from '../accessible-display';
import { DEFAULT_DISPLAY_OPTIONS, DISPLAY_OPTIONS_SELECT } from '@/lib/accessible-display-options';

const STAFF: TenantContext = { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'STAFF' };
const CONTACT: TenantContext = {
  tenantId: 'tenant-a',
  actorId: 'contact-a',
  actorType: 'CLIENT_CONTACT',
};
const tx = {
  staffUser: { findFirst: mocks.staffFindFirst },
  clientContact: { findFirst: mocks.contactFindFirst },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.staffFindFirst.mockResolvedValue({ accessibleDisplay: false });
  mocks.contactFindFirst.mockResolvedValue({ accessibleDisplay: false });
  mocks.withTenantContext.mockImplementation(
    async (_ctx: TenantContext, fn: (transaction: typeof tx) => unknown) => fn(tx),
  );
});

describe('readAccessibleDisplay', () => {
  it.each([STAFF, CONTACT])(
    'liest individuelle Optionen profilgebunden: $actorType',
    async (ctx) => {
      mocks.staffFindFirst.mockResolvedValue({
        accessibleDisplay: true,
        accessibleDisplayFontSize: 'extra-large',
      });
      mocks.contactFindFirst.mockResolvedValue({
        accessibleDisplay: false,
        accessibleDisplaySpacing: 'wide',
      });
      const options = await readAccessibleDisplayOptions(ctx);
      expect(options).toEqual({
        ...DEFAULT_DISPLAY_OPTIONS,
        ...(ctx.actorType === 'STAFF' ? { fontSize: 'extra-large' } : { spacing: 'wide' }),
      });
      expect(mocks.withTenantContext).toHaveBeenCalledWith(ctx, expect.any(Function));
    },
  );
  it('reads only the active staff profile in the supplied verified tenant context', async () => {
    mocks.staffFindFirst.mockResolvedValueOnce({ accessibleDisplay: true });

    expect(await readAccessibleDisplay(STAFF)).toBe(true);
    expect(mocks.withTenantContext).toHaveBeenCalledWith(STAFF, expect.any(Function));
    expect(mocks.staffFindFirst).toHaveBeenCalledWith({
      where: { id: 'staff-a', tenantId: 'tenant-a', active: true },
      select: { accessibleDisplay: true, ...DISPLAY_OPTIONS_SELECT },
    });
    expect(mocks.contactFindFirst).not.toHaveBeenCalled();
  });

  it('reads only the current active portal contact, not all profiles sharing its email', async () => {
    mocks.contactFindFirst.mockResolvedValueOnce({ accessibleDisplay: true });

    expect(await readAccessibleDisplay(CONTACT)).toBe(true);
    expect(mocks.withTenantContext).toHaveBeenCalledWith(CONTACT, expect.any(Function));
    expect(mocks.contactFindFirst).toHaveBeenCalledWith({
      where: { id: 'contact-a', tenantId: 'tenant-a', active: true },
      select: { accessibleDisplay: true, ...DISPLAY_OPTIONS_SELECT },
    });
    expect(mocks.staffFindFirst).not.toHaveBeenCalled();
  });

  it.each([STAFF, CONTACT])(
    'defaults to false for a missing or inactive $actorType',
    async (ctx) => {
      mocks.staffFindFirst.mockResolvedValue(null);
      mocks.contactFindFirst.mockResolvedValue(null);
      expect(await readAccessibleDisplay(ctx)).toBe(false);
    },
  );

  it.each([STAFF, CONTACT])('preserves the disabled preference for $actorType', async (ctx) => {
    expect(await readAccessibleDisplay(ctx)).toBe(false);
  });

  it.each([
    { tenantId: 'tenant-a', actorId: null, actorType: 'STAFF' },
    { tenantId: 'tenant-a', actorId: null, actorType: 'CLIENT_CONTACT' },
    { tenantId: 'tenant-a', actorId: 'staff-a', actorType: 'SYSTEM' },
  ] satisfies TenantContext[])(
    'does not invent a profile for $actorType / $actorId',
    async (ctx) => {
      expect(await readAccessibleDisplay(ctx)).toBe(false);
      expect(mocks.withTenantContext).not.toHaveBeenCalled();
    },
  );

  it('keeps staff, portal profiles and tenants separate without shared preference state', async () => {
    mocks.staffFindFirst.mockResolvedValue({ accessibleDisplay: true });
    mocks.contactFindFirst.mockImplementation(
      async ({ where }: { where: { id: string; tenantId: string } }) => ({
        accessibleDisplay: where.id === 'contact-a' && where.tenantId === 'tenant-a',
      }),
    );

    expect(await readAccessibleDisplay(STAFF)).toBe(true);
    expect(await readAccessibleDisplay(CONTACT)).toBe(true);
    expect(await readAccessibleDisplay({ ...CONTACT, actorId: 'contact-b' })).toBe(false);
    expect(await readAccessibleDisplay({ ...CONTACT, tenantId: 'tenant-b' })).toBe(false);
    expect(await readAccessibleDisplay({ ...STAFF, actorType: 'CLIENT_CONTACT' })).toBe(false);
  });

  it('does not replace a failed profile lookup with another profile or browser default', async () => {
    mocks.staffFindFirst.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(readAccessibleDisplay(STAFF)).rejects.toThrow('database unavailable');
    expect(mocks.contactFindFirst).not.toHaveBeenCalled();
  });
});
