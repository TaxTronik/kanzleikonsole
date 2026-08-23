import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  filterStaffAccessClientTx: vi.fn(),
  canOtherStaffAccessClientTx: vi.fn(),
}));

vi.mock('@/server/auth/rbac', () => ({
  filterStaffAccessClientTx: h.filterStaffAccessClientTx,
  canOtherStaffAccessClientTx: h.canOtherStaffAccessClientTx,
}));
vi.mock('@/server/actions/portal-action', () => ({
  ActionError: class ActionError extends Error {},
}));

import { assertAppointmentStaffOptionTx, readAppointmentStaffOptionsTx } from '../staff-options';

describe('Portal-Terminanfrage: Personenwahl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('liefert im OPEN-Fall alle von der zentralen Policy erlaubten aktiven Personen', async () => {
    const staff = [
      { id: 'staff-a', fullName: 'Anna Aktiv' },
      { id: 'staff-b', fullName: 'Bernd Aktiv' },
    ];
    const tx = { staffUser: { findMany: vi.fn().mockResolvedValue(staff) } };
    h.filterStaffAccessClientTx.mockResolvedValue(new Set(['staff-a', 'staff-b']));

    await expect(
      readAppointmentStaffOptionsTx(tx as never, 'tenant-1', 'client-1'),
    ).resolves.toEqual(staff);

    expect(tx.staffUser.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    });
    expect(h.filterStaffAccessClientTx).toHaveBeenCalledWith(
      tx,
      'tenant-1',
      ['staff-a', 'staff-b'],
      'client-1',
    );
  });

  it('entfernt im RESTRICTED-/Vertraulich-Fall von der Policy abgelehnte Personen', async () => {
    const tx = {
      staffUser: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'staff-admin', fullName: 'Ada Admin' },
          { id: 'staff-assigned', fullName: 'Berta Zuständig' },
          { id: 'staff-denied', fullName: 'Chris Ohne Zugriff' },
        ]),
      },
    };
    h.filterStaffAccessClientTx.mockResolvedValue(new Set(['staff-admin', 'staff-assigned']));

    await expect(
      readAppointmentStaffOptionsTx(tx as never, 'tenant-1', 'client-1'),
    ).resolves.toEqual([
      { id: 'staff-admin', fullName: 'Ada Admin' },
      { id: 'staff-assigned', fullName: 'Berta Zuständig' },
    ]);
  });

  it('lehnt eine manipulierte Zielperson über dieselbe zentrale Policy ab', async () => {
    h.canOtherStaffAccessClientTx.mockResolvedValue(false);

    await expect(
      assertAppointmentStaffOptionTx({} as never, 'tenant-1', 'client-1', 'staff-denied'),
    ).rejects.toThrow('Die ausgewählte Person ist für diesen Mandanten nicht verfügbar.');
  });
});
