import { beforeEach, describe, expect, it, vi } from 'vitest';

const eligibleInboxStaffIdsTx = vi.hoisted(() => vi.fn());
vi.mock('../access', () => ({ eligibleInboxStaffIdsTx }));

import { resolveInboxAssigneeTx, resolveInboxNotificationRecipientsTx } from '../routing';

function txFixture() {
  return {
    clientResponsibility: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
  };
}

describe('ACCESS-NOTIFICATION-RECIPIENT-001 / PORTAL-INBOX-SUBMISSION-001 routing', () => {
  beforeEach(() => vi.resetAllMocks());

  it('weist nur bei genau einem aktuell berechtigten Hauptbearbeiter automatisch zu', async () => {
    const tx = txFixture();
    tx.clientResponsibility.findMany.mockResolvedValue([
      { staffId: 'staff-a' },
      { staffId: 'staff-b' },
    ]);
    eligibleInboxStaffIdsTx.mockResolvedValueOnce(new Set(['staff-a']));
    await expect(resolveInboxAssigneeTx(tx as never, 'tenant-1', 'client-1')).resolves.toBe(
      'staff-a',
    );

    eligibleInboxStaffIdsTx.mockResolvedValueOnce(new Set(['staff-a', 'staff-b']));
    await expect(resolveInboxAssigneeTx(tx as never, 'tenant-1', 'client-1')).resolves.toBeNull();
  });

  it('bevorzugt einen weiterhin berechtigten Assignee', async () => {
    const tx = txFixture();
    eligibleInboxStaffIdsTx.mockResolvedValue(new Set(['staff-a']));
    await expect(
      resolveInboxNotificationRecipientsTx(tx as never, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        assignedStaffId: 'staff-a',
      }),
    ).resolves.toEqual(['staff-a']);
    expect(tx.clientResponsibility.findMany).not.toHaveBeenCalled();
  });

  it('fällt nach unberechtigtem Assignee und fehlendem Hauptbearbeiter auf berechtigte Admins zurück', async () => {
    const tx = txFixture();
    tx.clientResponsibility.findMany.mockResolvedValue([]);
    tx.staffUser.findMany.mockResolvedValue([{ id: 'admin-a' }, { id: 'admin-b' }]);
    eligibleInboxStaffIdsTx
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(['admin-b']));

    await expect(
      resolveInboxNotificationRecipientsTx(tx as never, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        assignedStaffId: 'former-assignee',
      }),
    ).resolves.toEqual(['admin-b']);
  });
});
