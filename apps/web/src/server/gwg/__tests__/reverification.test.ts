import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { Prisma } from '@prisma/client';
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
      notification: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
      data: {
        status: 'DRAFT',
        reviewSubmittedAt: null,
        reviewSubmittedBy: null,
        riskLevel: null,
        riskScore: null,
        riskAnswers: Prisma.DbNull,
        riskBreakdown: Prisma.DbNull,
      },
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
      notification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as TxClient;

    const result = await requireGwgReverificationTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: 'open-review' },
      data: {
        status: 'DRAFT',
        reviewSubmittedAt: null,
        reviewSubmittedBy: null,
        riskLevel: null,
        riskScore: null,
        riskAnswers: Prisma.DbNull,
        riskBreakdown: Prisma.DbNull,
      },
      select: { id: true },
    });
    expect(tx.gwgCheck.create).not.toHaveBeenCalled();
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        readAt: null,
        OR: [
          { resourceType: 'gwg_check', resourceId: 'open-review' },
          { href: '/staff/clients/client-1/gwg' },
        ],
        kind: { in: ['GWG_ONBOARDING_SUBMITTED'] },
      },
      data: { readAt: expect.any(Date) },
    });
    expect(result).toEqual({
      invalidatedChecks: 0,
      invalidatedIdentityDocuments: 1,
      reviewCheckId: 'open-review',
      clientDeactivated: false,
    });
  });

  it('verknüpft einen neuen Stammdaten-Recheck mit dem vor Entwertung neuesten Terminal-Snapshot', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: 'verified-predecessor' })
      .mockResolvedValueOnce(null);
    const invalidateChecks = vi.fn().mockResolvedValue({ count: 1 });
    const createReview = vi.fn().mockResolvedValue({ id: 'master-data-review' });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([
        {
          statementTimestamp: new Date('2026-07-16T12:00:00.000Z'),
          latestCreatedAt: new Date('2026-07-16T11:00:00.000Z'),
        },
      ]),
      gwgCheck: {
        findFirst,
        updateMany: invalidateChecks,
        create: createReview,
      },
      gwgIdDocument: { updateMany: vi.fn() },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    await expect(
      requireGwgReverificationTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
      }),
    ).resolves.toEqual({
      invalidatedChecks: 1,
      invalidatedIdentityDocuments: 0,
      reviewCheckId: 'master-data-review',
      clientDeactivated: true,
    });

    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: { in: ['VERIFIED', 'REJECTED', 'EXPIRED'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        beneficialOwners: true,
        representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
        idDocuments: {
          include: {
            document: {
              select: {
                id: true,
                tenantId: true,
                clientId: true,
                classification: true,
                deletedAt: true,
                gwgDestructionRequestedAt: true,
                gwgDestroyedAt: true,
              },
            },
          },
        },
      },
    });
    expect(createReview).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: 'DRAFT',
        createdAt: new Date('2026-07-16T12:00:00.000Z'),
        predecessorCheckId: 'verified-predecessor',
        changeScope: 'CLIENT_MASTER_DATA',
      },
      select: { id: true },
    });
    expect(findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateChecks.mock.invocationCallOrder[0]!,
    );
  });

  it('kennzeichnet einen Recheck ohne irgendeinen Vorgänger weiterhin als Erstprüfung', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const createReview = vi.fn().mockResolvedValue({ id: 'initial-review' });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([
        {
          statementTimestamp: new Date('2026-07-16T12:00:00.000Z'),
          latestCreatedAt: null,
        },
      ]),
      gwgCheck: {
        findFirst,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: createReview,
      },
      gwgIdDocument: { updateMany: vi.fn() },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    await requireGwgReverificationTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(createReview).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: 'DRAFT',
        createdAt: new Date('2026-07-16T12:00:00.000Z'),
        predecessorCheckId: null,
        changeScope: 'INITIAL',
      },
      select: { id: true },
    });
  });

  it('kopiert die fachliche Arbeitsgrundlage eines Terminal-Snapshots ohne Risiko oder Bestätigung', async () => {
    const predecessor = {
      id: 'verified-predecessor',
      destroyedAt: null,
      notes: 'Altprüfung',
      legalForm: 'GbR',
      registerNumber: null,
      registerAuthority: null,
      noRegisterEntry: true,
      representativeNames: ['Rita Rolle'],
      ownershipStructureNotes: 'Direkte Beteiligung',
      beneficialOwners: [
        {
          id: 'owner-old',
          fullName: 'Rita Rolle',
          birthDate: new Date('1980-01-01T00:00:00.000Z'),
          birthPlace: 'Berlin',
          residence: 'Berlin',
          nationality: 'DE',
          ownershipPct: 100,
          isPep: false,
          notes: null,
        },
      ],
      representatives: [
        {
          id: 'rep-old',
          fullName: 'Rita Rolle',
          position: 0,
          linkedBeneficialOwnerId: 'owner-old',
        },
      ],
      idDocuments: [
        {
          id: 'identity-old',
          documentSetId: 'set-old',
          documentId: 'document-old',
          type: 'PERSONALAUSWEIS',
          ownerName: 'Rita Rolle',
          number: 'ID-1',
          issuedBy: 'Berlin',
          issueDate: new Date('2020-01-01T00:00:00.000Z'),
          expiryDate: new Date('2030-01-01T00:00:00.000Z'),
          notes: null,
          document: {
            id: 'document-old',
            tenantId: 'tenant-1',
            clientId: 'client-1',
            classification: 'GWG_EVIDENCE',
            deletedAt: null,
            gwgDestructionRequestedAt: null,
            gwgDestroyedAt: null,
          },
        },
      ],
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([
        {
          statementTimestamp: new Date('2026-07-16T12:00:00.000Z'),
          latestCreatedAt: new Date('2026-07-15T12:00:00.000Z'),
        },
      ]),
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValueOnce(predecessor).mockResolvedValueOnce(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: 'copied-review' }),
        update: vi.fn().mockResolvedValue({ id: 'copied-review' }),
      },
      gwgBeneficialOwner: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      gwgRepresentative: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      gwgIdDocument: {
        updateMany: vi.fn(),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    await requireGwgReverificationTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.update).toHaveBeenCalledWith({
      where: { id: 'copied-review' },
      data: {
        notes: 'Altprüfung',
        legalForm: 'GbR',
        registerNumber: null,
        registerAuthority: null,
        noRegisterEntry: true,
        representativeNames: ['Rita Rolle'],
        ownershipStructureNotes: 'Direkte Beteiligung',
      },
    });
    expect(tx.gwgBeneficialOwner.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          gwgCheckId: 'copied-review',
          fullName: 'Rita Rolle',
          isPep: false,
        }),
      ],
    });
    expect(tx.gwgRepresentative.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          gwgCheckId: 'copied-review',
          fullName: 'Rita Rolle',
          linkedBeneficialOwnerId: expect.any(String),
        }),
      ],
    });
    expect(tx.gwgIdDocument.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          gwgCheckId: 'copied-review',
          documentId: 'document-old',
          documentSetId: expect.any(String),
        }),
      ],
    });
    const copiedDocumentData = vi.mocked(tx.gwgIdDocument.createMany).mock.calls[0]![0]!.data;
    const copiedDocument = Array.isArray(copiedDocumentData)
      ? copiedDocumentData[0]!
      : copiedDocumentData;
    expect(copiedDocument).not.toHaveProperty('verifiedAt');
    expect(copiedDocument).not.toHaveProperty('beneficialOwnerSubjectId');
    expect(tx.gwgCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          predecessorCheckId: 'verified-predecessor',
          changeScope: 'CLIENT_MASTER_DATA',
        }),
      }),
    );
    const copiedCheck = vi.mocked(tx.gwgCheck.create).mock.calls[0]![0].data;
    expect(copiedCheck).not.toHaveProperty('riskAnswers');
    expect(copiedCheck).not.toHaveProperty('riskScore');
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
        predecessorCheckId: null,
        changeScope: 'INITIAL',
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
