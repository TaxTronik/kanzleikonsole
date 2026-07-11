import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  claimGwgOnboardingSubmitTx,
  lockGwgOnboardingUploadTx,
  requireGwgReverificationTx,
  startFreshGwgReviewTx,
} from '../reverification';

describe('GwG-Onboarding-Submit-Claim', () => {
  it('sperrt Uploads nur bei exakt passender offener Einladung', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'invite-1' }])
      .mockResolvedValueOnce([]);
    const tx = { $queryRaw: queryRaw } as unknown as TxClient;
    const now = new Date('2026-07-11T12:00:00.000Z');
    const input = {
      inviteId: 'invite-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      tokenHash: 'token-hash',
      now,
    };

    await expect(lockGwgOnboardingUploadTx(tx, input)).resolves.toBe(true);
    await expect(lockGwgOnboardingUploadTx(tx, input)).resolves.toBe(false);

    const [fragments, ...values] = queryRaw.mock.calls[0]!;
    const sql = (fragments as readonly string[]).join('?');
    expect(sql).toContain('tenant_id = ?::uuid');
    expect(sql).toContain('client_id = ?::uuid');
    expect(sql).toContain('token_hash = ?');
    expect(sql).toContain("status IN ('PENDING'::gwg_invite_status, 'STARTED'::gwg_invite_status)");
    expect(sql).toContain('expires_at > ?');
    expect(sql).toContain('FOR UPDATE');
    expect(values).toEqual(['invite-1', 'tenant-1', 'client-1', 'token-hash', now]);
  });

  it('beansprucht einen oeffentlichen Submit nur aus einem offenen Status', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const tx = {
      gwgOnboardingInvite: { updateMany },
    } as unknown as TxClient;
    const submittedAt = new Date('2026-07-11T12:00:00.000Z');
    const input = {
      inviteId: 'invite-1',
      tokenHash: 'token-hash',
      submittedAt,
      submittedIp: '192.0.2.1',
      submittedUa: 'test-agent',
    };

    await expect(claimGwgOnboardingSubmitTx(tx, input)).resolves.toBe(true);
    await expect(claimGwgOnboardingSubmitTx(tx, input)).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        tokenHash: 'token-hash',
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { gt: submittedAt },
      },
      data: {
        status: 'SUBMITTED',
        submittedAt,
        submittedIp: '192.0.2.1',
        submittedUa: 'test-agent',
      },
    });
  });
});

describe('GwG-Wiederholungsprüfung', () => {
  it('entwertet VERIFIED-Snapshots, deaktiviert und erhält deren Aggregate', async () => {
    const tx = {
      gwgCheck: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'open-review' }),
        create: vi.fn(),
        deleteMany: vi.fn(),
      },
      gwgBeneficialOwner: { deleteMany: vi.fn() },
      gwgIdDocument: { deleteMany: vi.fn() },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    const result = await requireGwgReverificationTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: 'VERIFIED' },
      data: { status: 'EXPIRED' },
    });
    expect(tx.client.updateMany).toHaveBeenCalledWith({
      where: { id: 'client-1', tenantId: 'tenant-1', allowActive: true },
      data: { allowActive: false },
    });
    expect(result).toEqual({
      invalidatedChecks: 1,
      reviewCheckId: 'open-review',
      clientDeactivated: true,
    });
    expect(tx.gwgCheck.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgBeneficialOwner.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.deleteMany).not.toHaveBeenCalled();
  });

  it('öffentliches Onboarding legt immer einen frischen Review-Check an', async () => {
    const tx = {
      gwgCheck: {
        create: vi.fn().mockResolvedValue({ id: 'new-review' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    const result = await startFreshGwgReviewTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', clientId: 'client-1', status: 'IN_REVIEW' },
      select: { id: true },
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: 'VERIFIED', id: { not: 'new-review' } },
      data: { status: 'EXPIRED' },
    });
    expect(result).toEqual({
      invalidatedChecks: 1,
      reviewCheckId: 'new-review',
      clientDeactivated: true,
    });
  });
});
