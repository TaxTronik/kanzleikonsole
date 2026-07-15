import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { claimCurrentGwgInviteSubmitTx, prepareGwgInviteIssueTx } from '../invite-lifecycle';

afterEach(() => {
  vi.useRealTimers();
});

describe('GwG-Einladungs-Lifecycle', () => {
  it('führt beide Staff-Ausstellpfade über denselben Supersession-Helper', () => {
    const directInvite = readFileSync(
      new URL('../../../app/staff/(protected)/clients/[id]/gwg/invite-actions.ts', import.meta.url),
      'utf8',
    );
    const onboardingInvite = readFileSync(
      new URL('../../../app/staff/(protected)/clients/onboarding/[id]/actions.ts', import.meta.url),
      'utf8',
    );

    expect(directInvite).toContain('await prepareGwgInviteIssueTx(tx,');
    expect(onboardingInvite).toContain('await prepareGwgInviteIssueTx(tx,');
  });

  it('entwertet offene Vorgänger unter dem Lock und vergibt createdAt strikt monoton', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    const executeRaw = vi.fn().mockResolvedValue(0);
    const findLatest = vi.fn().mockResolvedValue({
      createdAt: new Date('2026-07-15T12:00:00.000Z'),
    });
    const cancelOpen = vi.fn().mockResolvedValue({ count: 2 });
    const tx = {
      $executeRaw: executeRaw,
      gwgOnboardingInvite: {
        findFirst: findLatest,
        updateMany: cancelOpen,
      },
    } as unknown as TxClient;

    const result = await prepareGwgInviteIssueTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      cancelledByStaff: 'staff-1',
    });

    expect(result).toEqual({
      createdAt: new Date('2026-07-15T12:00:00.001Z'),
      supersededInviteCount: 2,
    });
    expect(cancelOpen).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: { in: ['PENDING', 'STARTED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date('2026-07-15T12:00:00.000Z'),
        cancelledByStaff: 'staff-1',
        tokenHash: '',
      },
    });
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findLatest.mock.invocationCallOrder[0]!,
    );
    expect(findLatest.mock.invocationCallOrder[0]).toBeLessThan(
      cancelOpen.mock.invocationCallOrder[0]!,
    );
  });

  it('claimed nur die neueste Einladung und entwertet danach alle anderen offenen Links', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:30:00.000Z'));
    const executeRaw = vi.fn().mockResolvedValue(0);
    const findLatest = vi.fn().mockResolvedValue({ id: 'invite-new' });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 3 });
    const tx = {
      $executeRaw: executeRaw,
      gwgOnboardingInvite: { findFirst: findLatest, updateMany },
    } as unknown as TxClient;

    const result = await claimCurrentGwgInviteSubmitTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      inviteId: 'invite-new',
      tokenHash: 'new-token',
      submittedIp: '192.0.2.1',
      submittedUa: 'test-agent',
    });

    expect(result).toEqual({
      ok: true,
      submittedAt: new Date('2026-07-15T12:30:00.000Z'),
      supersededInviteCount: 3,
    });
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'invite-new',
        tokenHash: 'new-token',
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { gt: new Date('2026-07-15T12:30:00.000Z') },
      },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date('2026-07-15T12:30:00.000Z'),
        submittedIp: '192.0.2.1',
        submittedUa: 'test-agent',
      },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        id: { not: 'invite-new' },
        status: { in: ['PENDING', 'STARTED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date('2026-07-15T12:30:00.000Z'),
        cancelledByStaff: null,
        tokenHash: '',
      },
    });
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findLatest.mock.invocationCallOrder[0]!,
    );
    expect(findLatest.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it('weist einen älteren Token vor jeder Statusmutation als superseded ab', async () => {
    const updateMany = vi.fn();
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgOnboardingInvite: {
        findFirst: vi.fn().mockResolvedValue({ id: 'invite-new' }),
        updateMany,
      },
    } as unknown as TxClient;

    await expect(
      claimCurrentGwgInviteSubmitTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-old',
        tokenHash: 'old-token',
        submittedIp: null,
        submittedUa: null,
      }),
    ).resolves.toEqual({ ok: false, reason: 'SUPERSEDED' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('lässt bei parallelem altem und neuem Submit nur den neuesten Claim mutieren', async () => {
    const oldUpdate = vi.fn();
    const newUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const baseInput = {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      submittedIp: null,
      submittedUa: null,
    };
    const oldTx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgOnboardingInvite: {
        findFirst: vi.fn().mockResolvedValue({ id: 'invite-new' }),
        updateMany: oldUpdate,
      },
    } as unknown as TxClient;
    const newTx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgOnboardingInvite: {
        findFirst: vi.fn().mockResolvedValue({ id: 'invite-new' }),
        updateMany: newUpdate,
      },
    } as unknown as TxClient;

    const [oldResult, newResult] = await Promise.all([
      claimCurrentGwgInviteSubmitTx(oldTx, {
        ...baseInput,
        inviteId: 'invite-old',
        tokenHash: 'old-token',
      }),
      claimCurrentGwgInviteSubmitTx(newTx, {
        ...baseInput,
        inviteId: 'invite-new',
        tokenHash: 'new-token',
      }),
    ]);

    expect(oldResult).toEqual({ ok: false, reason: 'SUPERSEDED' });
    expect(newResult.ok).toBe(true);
    expect(oldUpdate).not.toHaveBeenCalled();
    expect(newUpdate).toHaveBeenCalledTimes(2);
  });
});
