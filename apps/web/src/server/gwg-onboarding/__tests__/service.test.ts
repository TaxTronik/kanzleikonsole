import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    gwgOnboardingInvite: {
      findFirst: m.findFirst,
      updateMany: m.updateMany,
      update: m.update,
    },
  },
}));

import { GENERIC_TOKEN_ERROR, loadInviteByRawToken } from '../service';

const activeInvite = {
  id: 'invite-1',
  inviteName: 'Erika Muster',
  inviteEmail: 'erika@example.test',
  tokenHash: 'unused-in-test',
  status: 'PENDING',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  client: {
    id: 'client-1',
    name: 'Muster GmbH',
    kind: 'JURPERS',
    street: null,
    postalCode: null,
    city: null,
    countryIso: 'DE',
    vatId: null,
  },
  tenant: { id: 'tenant-1', name: 'Kanzlei', slug: 'kanzlei' },
};

describe('GwG-Onboarding-Tokenstatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ueberschreibt einen parallel geclaimten Invite beim Ablauf-Lookup nicht', async () => {
    const now = new Date('2030-01-02T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    m.findFirst.mockResolvedValueOnce({
      ...activeInvite,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    // Der Datensatz wurde zwischen Read und Write bereits auf SUBMITTED
    // geclaimt. Der statusgebundene CAS trifft deshalb keine Zeile.
    m.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(loadInviteByRawToken('valid-looking-raw-token')).resolves.toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('belebt eine parallel supersedierte Einladung nicht wieder als STARTED', async () => {
    m.findFirst.mockResolvedValueOnce(activeInvite).mockResolvedValueOnce(null);
    m.updateMany.mockResolvedValue({ count: 0 });

    await expect(loadInviteByRawToken('valid-looking-raw-token')).resolves.toEqual({
      ok: false,
      error: GENERIC_TOKEN_ERROR,
    });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'invite-1',
          status: 'PENDING',
        }),
        data: { status: 'STARTED' },
      }),
    );
  });

  it('akzeptiert zwei parallele Öffnungen, wenn der andere Request STARTED gesetzt hat', async () => {
    m.findFirst.mockResolvedValueOnce(activeInvite).mockResolvedValueOnce({ id: 'invite-1' });
    m.updateMany.mockResolvedValue({ count: 0 });

    const result = await loadInviteByRawToken('valid-looking-raw-token');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invite.status).toBe('STARTED');
  });
});
