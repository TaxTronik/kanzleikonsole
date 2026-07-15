import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  claimGwgOnboardingSubmitTx,
  lockGwgCheckLifecycleTx,
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
  it('bildet den Lifecycle-Lock aus Tenant und Mandant', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const tx = { $executeRaw: executeRaw } as unknown as TxClient;

    await lockGwgCheckLifecycleTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    const [fragments, ...values] = executeRaw.mock.calls[0]!;
    const sql = (fragments as readonly string[]).join('?');
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(?, 0))');
    expect(values).toEqual(['gwg-check-lifecycle:tenant-1:client-1']);
  });

  it('führt wiederholte Defense-in-Depth-Lockaufrufe auf derselben Tx nur einmal aus', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const tx = { $executeRaw: executeRaw } as unknown as TxClient;
    const input = { tenantId: 'tenant-1', clientId: 'client-1' };

    await Promise.all([lockGwgCheckLifecycleTx(tx, input), lockGwgCheckLifecycleTx(tx, input)]);
    await lockGwgCheckLifecycleTx(tx, input);

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('entwertet VERIFIED-Snapshots, deaktiviert und erhält deren Aggregate', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const invalidateChecks = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: executeRaw,
      gwgCheck: {
        updateMany: invalidateChecks,
        findFirst: vi.fn().mockResolvedValue({ id: 'open-review' }),
        update: vi.fn().mockResolvedValue({ id: 'open-review' }),
        create: vi.fn(),
        deleteMany: vi.fn(),
      },
      gwgBeneficialOwner: { deleteMany: vi.fn() },
      gwgIdDocument: {
        deleteMany: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
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
      invalidatedIdentityDocuments: 2,
      reviewCheckId: 'open-review',
      clientDeactivated: true,
    });
    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: 'open-review' },
      data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
      select: { id: true },
    });
    expect(tx.gwgCheck.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgBeneficialOwner.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.updateMany).toHaveBeenCalledWith({
      where: {
        gwgCheckId: 'open-review',
        type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] },
      },
      data: {
        naturalClientSubjectId: null,
        beneficialOwnerSubjectId: null,
        representativeSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      },
    });
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateChecks.mock.invocationCallOrder[0]!,
    );
  });

  it('nimmt einen laufenden Review nach Stammdatenänderung auch ohne VERIFIED-Snapshot zurück', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgCheck: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'open-review', status: 'IN_REVIEW' }),
        update: vi.fn().mockResolvedValue({ id: 'open-review' }),
        create: vi.fn(),
      },
      gwgIdDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    const result = await requireGwgReverificationTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: 'open-review' },
      data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
      select: { id: true },
    });
    expect(tx.gwgCheck.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      invalidatedChecks: 0,
      invalidatedIdentityDocuments: 1,
      reviewCheckId: 'open-review',
      clientDeactivated: false,
    });
  });

  it('legt B mit monotonem Zeitstempel frisch an und terminalisiert den älteren Review A', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const createReview = vi.fn().mockResolvedValue({ id: 'new-review' });
    const queryRaw = vi.fn().mockResolvedValue([
      {
        statementTimestamp: new Date('2026-07-15T12:00:00.000Z'),
        latestCreatedAt: new Date('2026-07-15T12:00:00.000Z'),
      },
    ]);
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
      gwgCheck: {
        create: createReview,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    const result = await startFreshGwgReviewTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: 'DRAFT',
        createdAt: new Date('2026-07-15T12:00:00.001Z'),
      },
      select: { id: true },
    });
    const [clockFragments, ...clockValues] = queryRaw.mock.calls[0]!;
    const clockSql = (clockFragments as readonly string[]).join('?');
    expect(clockSql).toContain('statement_timestamp()');
    expect(clockSql).toContain('MAX(created_at)');
    expect(clockValues).toEqual(['tenant-1', 'client-1']);
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: { in: ['DRAFT', 'IN_REVIEW', 'VERIFIED'] },
        id: { not: 'new-review' },
      },
      data: { status: 'EXPIRED' },
    });
    expect(result).toEqual({
      invalidatedChecks: 1,
      invalidatedIdentityDocuments: 0,
      reviewCheckId: 'new-review',
      clientDeactivated: true,
    });
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      createReview.mock.invocationCallOrder[0]!,
    );
  });
});
