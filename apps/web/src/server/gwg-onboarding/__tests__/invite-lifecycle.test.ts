import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { gwgInviteClientBaselineHash } from '../invite-draft-revision';
import {
  claimCurrentGwgInviteSubmitTx,
  prepareGwgInviteIssueTx,
  revalidateOpenGwgInviteRevisionTx,
} from '../invite-lifecycle';

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
    expect(directInvite).toContain('await prepareGwgInviteBindingTx(tx,');
    expect(directInvite).toContain('requestedCheckId: gwgCheckId');
    expect(directInvite).toContain('bindLatestDraft: false');
    expect(onboardingInvite).toContain('await prepareGwgInviteBindingTx(tx,');
    expect(onboardingInvite).toContain('bindLatestDraft: true');
    expect(onboardingInvite).toContain('gwgCheckId: binding.gwgCheckId');
    expect(onboardingInvite).toContain('boundCheckRevision: binding.boundCheckRevision');
    expect(directInvite).toContain("await emitN8nEvent(\n    'gwg.invite.created'");
    expect(onboardingInvite).toContain("await emitN8nEvent(\n    'gwg.invite.created'");
    expect(directInvite).not.toContain("n8nEvent: 'gwg.invite.created'");
    expect(onboardingInvite).not.toContain("n8nEvent: 'gwg.invite.created'");
    expect(directInvite).not.toContain("n8nEvent: 'client.created'");
    expect(onboardingInvite).not.toContain("n8nEvent: 'client.created'");
    expect(directInvite).not.toMatch(/n8nPayload:\s*\{[\s\S]{0,300}\blink[,}]/);
    expect(onboardingInvite).not.toMatch(/n8nPayload:\s*\{[\s\S]{0,300}\blink[,}]/);
  });

  it('entwertet eine ungebundene Ersteinladung nach Kanzleiänderung vor Seite oder Upload', async () => {
    const issuedClient = {
      id: 'client-1',
      tenantId: 'tenant-1',
      kind: 'PERSGES' as const,
      name: 'Alt GbR',
      street: null,
      postalCode: null,
      city: null,
      countryIso: 'DE',
      vatId: null,
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invite-1' }]),
      gwgOnboardingInvite: {
        findUnique: vi.fn().mockResolvedValue({
          gwgCheckId: null,
          boundCheckRevision: null,
          boundClientRevision: gwgInviteClientBaselineHash(issuedClient),
        }),
        updateMany,
      },
      gwgCheck: { findFirst: vi.fn().mockResolvedValue(null) },
      client: { findFirst: vi.fn().mockResolvedValue({ ...issuedClient, name: 'Neu GbR' }) },
    } as unknown as TxClient;
    const now = new Date('2026-07-16T12:00:00.000Z');

    await expect(
      revalidateOpenGwgInviteRevisionTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-1',
        tokenHash: 'token-hash',
        now,
      }),
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        tokenHash: 'token-hash',
        status: { in: ['PENDING', 'STARTED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledByStaff: null,
        tokenHash: '',
      },
    });
  });

  it('entwertet einen gebundenen Link, sobald ein Nachfolgecheck existiert', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invite-1' }]),
      gwgOnboardingInvite: {
        findUnique: vi.fn().mockResolvedValue({
          gwgCheckId: 'check-old',
          boundCheckRevision: 'issued-revision',
          boundClientRevision: null,
        }),
        updateMany,
      },
      gwgCheck: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'check-new',
          status: 'DRAFT',
        }),
      },
    } as unknown as TxClient;

    await expect(
      revalidateOpenGwgInviteRevisionTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-1',
        tokenHash: 'token-hash',
        now: new Date(),
      }),
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it('entwertet offene Links bei Review-Submit, Verify, Reject und neuem Zyklus', () => {
    const actions = readFileSync(
      new URL('../../../app/staff/(protected)/clients/[id]/gwg/actions.ts', import.meta.url),
      'utf8',
    );
    expect(actions.match(/await cancelOpenGwgInvitesTx\(tx,/g)).toHaveLength(4);
    for (const actionName of [
      'startCheckCycle',
      'submitCheckForReviewAction',
      'verifyCheckAction',
      'rejectCheckAction',
    ]) {
      const actionStart = actions.indexOf(`function ${actionName}`);
      const nextExport = actions.indexOf('\nexport ', actionStart + 1);
      const actionSource = actions.slice(
        actionStart,
        nextExport === -1 ? actions.length : nextExport,
      );
      expect(actionSource).toContain('await cancelOpenGwgInvitesTx(tx,');
    }
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
      gwgOnboardingInvite: {
        findFirst: findLatest,
        findUnique: vi.fn().mockResolvedValue({
          gwgCheckId: null,
          boundCheckRevision: null,
          boundClientRevision: gwgInviteClientBaselineHash({
            id: 'client-1',
            tenantId: 'tenant-1',
            kind: 'PERSGES',
            name: 'Test GbR',
            street: null,
            postalCode: null,
            city: null,
            countryIso: 'DE',
          }),
        }),
        updateMany,
      },
      gwgCheck: { findFirst: vi.fn().mockResolvedValue(null) },
      client: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'client-1',
          tenantId: 'tenant-1',
          kind: 'PERSGES',
          name: 'Test GbR',
          street: null,
          postalCode: null,
          city: null,
          countryIso: 'DE',
          vatId: null,
        }),
      },
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

  it('committet die Entwertung eines stale Submit vor jeder Fachmutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:30:00.000Z'));
    const cancelStale = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      gwgOnboardingInvite: {
        findFirst: vi.fn().mockResolvedValue({ id: 'invite-1' }),
        findUnique: vi.fn().mockResolvedValue({
          gwgCheckId: null,
          boundCheckRevision: null,
          boundClientRevision: 'issued-client-revision',
        }),
        updateMany: cancelStale,
      },
      gwgCheck: { findFirst: vi.fn().mockResolvedValue(null) },
      client: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'client-1',
          tenantId: 'tenant-1',
          kind: 'PERSGES',
          name: 'Nach Ausgabe geändert',
          street: null,
          postalCode: null,
          city: null,
          countryIso: 'DE',
          vatId: null,
        }),
      },
    } as unknown as TxClient;

    await expect(
      claimCurrentGwgInviteSubmitTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        inviteId: 'invite-1',
        tokenHash: 'token-hash',
        submittedIp: null,
        submittedUa: null,
      }),
    ).resolves.toEqual({ ok: false, reason: 'STALE' });
    expect(cancelStale).toHaveBeenCalledOnce();
    expect(cancelStale).toHaveBeenCalledWith({
      where: {
        id: 'invite-1',
        tokenHash: 'token-hash',
        status: { in: ['PENDING', 'STARTED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date('2026-07-16T12:30:00.000Z'),
        cancelledByStaff: null,
        tokenHash: '',
      },
    });
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
        findUnique: vi.fn().mockResolvedValue({
          gwgCheckId: null,
          boundCheckRevision: null,
          boundClientRevision: gwgInviteClientBaselineHash({
            id: 'client-1',
            tenantId: 'tenant-1',
            kind: 'PERSGES',
            name: 'Test GbR',
            street: null,
            postalCode: null,
            city: null,
            countryIso: 'DE',
          }),
        }),
        updateMany: newUpdate,
      },
      gwgCheck: { findFirst: vi.fn().mockResolvedValue(null) },
      client: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'client-1',
          tenantId: 'tenant-1',
          kind: 'PERSGES',
          name: 'Test GbR',
          street: null,
          postalCode: null,
          city: null,
          countryIso: 'DE',
          vatId: null,
        }),
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
