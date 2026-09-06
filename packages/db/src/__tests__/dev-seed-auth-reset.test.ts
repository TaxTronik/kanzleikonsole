// Fachkatalog: ACCESS-TENANT-RLS-001
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resetExistingDevAdminAuth } from '../../seeds/lib';

describe('Dev-Seed Admin-Authentifizierungsreset', () => {
  it('deaktiviert Hardware-only, widerruft Schluessel und invalidiert Sitzungen atomar', async () => {
    const calls: string[] = [];
    const now = new Date('2026-09-04T10:00:00.000Z');
    const tx = {
      staffUser: {
        update: vi.fn(async () => {
          calls.push('staff');
          return { id: 'staff-1', email: 'admin@taxtronik.local' };
        }),
      },
      staffWebAuthnCredential: {
        updateMany: vi.fn(async () => {
          calls.push('credentials');
          return { count: 2 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      resetExistingDevAdminAuth(prisma, {
        staffUserId: 'staff-1',
        passwordHash: 'new-hash',
        now,
      }),
    ).resolves.toEqual({
      admin: { id: 'staff-1', email: 'admin@taxtronik.local' },
      revokedHardwareKeys: 2,
    });
    expect(calls).toEqual(['staff', 'credentials']);
    expect(tx.staffUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'staff-1' },
        data: expect.objectContaining({
          passwordHash: 'new-hash',
          active: true,
          hardwareOnlyEnabledAt: null,
          authRevision: { increment: 1 },
          totpSecretEnc: null,
          totpEnrolledAt: null,
          totpSetupStartedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        }),
      }),
    );
    expect(tx.staffWebAuthnCredential.updateMany).toHaveBeenCalledWith({
      where: { staffUserId: 'staff-1', revokedAt: null },
      data: { revokedAt: now },
    });
  });
});
