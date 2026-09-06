// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { EvidenceService } from '@taxtronik/evidence';
import {
  AdminBreakGlassTargetError,
  resetAdminAccessForBreakGlass,
  writeAdminBreakGlassCredentials,
} from '../admin-break-glass';

const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'taxtronik-admin-break-glass-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const calls: string[] = [];
  const current = {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.test',
    hardwareOnlyEnabledAt: new Date('2026-09-01T00:00:00.000Z'),
    tenant: { slug: 'kanzlei' },
  };
  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
      return [{ locked: '1' }];
    }),
    staffUser: {
      findMany: vi.fn(async () => {
        calls.push('candidate');
        return [current];
      }),
      findFirst: vi.fn(async (): Promise<typeof current | null> => {
        calls.push('fresh-read');
        return current;
      }),
      updateMany: vi.fn(async () => {
        calls.push('staff-update');
        return { count: 1 };
      }),
    },
    staffWebAuthnCredential: {
      count: vi.fn(async () => {
        calls.push('credential-count');
        return 2;
      }),
      updateMany: vi.fn(async () => {
        calls.push('credential-revoke');
        return { count: 2 };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
      calls.push('transaction-begin');
      try {
        const result = await callback(tx);
        calls.push('transaction-commit');
        return result;
      } catch (error) {
        calls.push('transaction-rollback');
        throw error;
      }
    }),
  } as unknown as PrismaClient;
  const record = vi.fn(async (..._args: unknown[]) => {
    calls.push('audit');
    return {
      id: 1n,
      occurredAt: new Date(),
      prevHash: Buffer.alloc(32),
      thisHash: Buffer.alloc(32),
    };
  });
  const evidence = { record } as unknown as Pick<EvidenceService, 'record'>;
  return { calls, current, tx, prisma, evidence, record };
}

describe('ADMIN-Owner-CLI Break-glass', () => {
  it('schreibt das Klartextpasswort niemals in die Terminalausgabe', () => {
    const cliSource = readFileSync(
      new URL('../../../../scripts/reset-admin-password.ts', import.meta.url),
      'utf8',
    );
    const consoleStatements = cliSource
      .split('\n')
      .filter((line) => line.includes('console.'))
      .join('\n');

    expect(consoleStatements).not.toContain('${password}');
    expect(consoleStatements).not.toMatch(/console\.(?:log|info|warn|error)\(password\)/);
  });

  it('legt die Recovery-Datei exklusiv mit restriktiven Rechten an', () => {
    const target = join(tempDirectory(), 'credentials.txt');

    expect(
      writeAdminBreakGlassCredentials({
        target,
        email: 'admin@example.test',
        password: 'temporary-secret',
      }),
    ).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(
      'email=admin@example.test\npassword=temporary-secret\n',
    );
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it('ueberschreibt weder eine vorhandene Datei noch ihr Ziel', () => {
    const target = join(tempDirectory(), 'credentials.txt');
    writeFileSync(target, 'bestehender-inhalt', 'utf8');

    expect(() =>
      writeAdminBreakGlassCredentials({
        target,
        email: 'admin@example.test',
        password: 'temporary-secret',
      }),
    ).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('bestehender-inhalt');
  });

  it('folgt keinem vorhandenen Symlink zur Recovery-Datei', () => {
    const directory = tempDirectory();
    const protectedTarget = join(directory, 'protected.txt');
    const link = join(directory, 'credentials.txt');
    writeFileSync(protectedTarget, 'nicht-ueberschreiben', 'utf8');
    try {
      symlinkSync(protectedTarget, link, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    expect(() =>
      writeAdminBreakGlassCredentials({
        target: link,
        email: 'admin@example.test',
        password: 'temporary-secret',
      }),
    ).toThrow();
    expect(readFileSync(protectedTarget, 'utf8')).toBe('nicht-ueberschreiben');
  });

  it('entfernt eine exklusiv angelegte Teildatei nach einem Schreibfehler', () => {
    const target = join(tempDirectory(), 'credentials.txt');
    const input = {
      target,
      email: 'admin@example.test',
      get password(): string {
        throw new Error('simulierter Exportfehler');
      },
    };

    expect(() => writeAdminBreakGlassCredentials(input)).toThrow(/simulierter Exportfehler/);
    expect(existsSync(target)).toBe(false);
  });

  it('synchronisiert auf POSIX neben der Datei auch den Elternordner', () => {
    const source = readFileSync(new URL('../admin-break-glass.ts', import.meta.url), 'utf8');

    expect(source).toContain('openSync(dirname(target)');
    expect(source).toContain('fsConstants.O_DIRECTORY');
    expect(source).toContain('syncParentDirectory(target)');
  });

  it('prueft das Ziel nach dem gemeinsamen Lock und auditiert Reset atomar ohne Geheimnisse', async () => {
    const f = fixture();
    const now = new Date('2026-09-04T10:00:00.000Z');

    await expect(
      resetAdminAccessForBreakGlass({
        prisma: f.prisma,
        evidence: f.evidence,
        adminEmail: 'admin@example.test',
        tenantSlug: 'kanzlei',
        passwordHash: 'very-secret-hash',
        now,
      }),
    ).resolves.toEqual({
      email: 'admin@example.test',
      tenantSlug: 'kanzlei',
      revokedHardwareKeys: 2,
    });

    expect(f.calls).toEqual([
      'transaction-begin',
      'candidate',
      'lock',
      'fresh-read',
      'credential-count',
      'staff-update',
      'credential-revoke',
      'audit',
      'transaction-commit',
    ]);
    expect(f.tx.staffUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          passwordHash: 'very-secret-hash',
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
    expect(f.tx.staffWebAuthnCredential.updateMany).toHaveBeenCalledWith({
      where: {
        staffUserId: f.current.id,
        tenantId: f.current.tenantId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    expect(f.record).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        tenantId: f.current.tenantId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'staff.hardware_access.reset',
        resourceId: f.current.id,
        before: { mode: 'hardware_only', activeSecurityKeys: 2 },
        after: {
          mode: 'password_totp_setup_required',
          activeSecurityKeys: 0,
          changedBy: 'owner_cli',
        },
      }),
    );
    expect(JSON.stringify(f.record.mock.calls[0]?.[1])).not.toContain('very-secret-hash');
  });

  it('bricht ohne Mutation ab, wenn die ADMIN-Zuordnung nach dem Lock nicht mehr gilt', async () => {
    const f = fixture();
    f.tx.staffUser.findFirst.mockResolvedValueOnce(null);

    await expect(
      resetAdminAccessForBreakGlass({
        prisma: f.prisma,
        evidence: f.evidence,
        adminEmail: 'admin@example.test',
        tenantSlug: 'kanzlei',
        passwordHash: 'hash',
      }),
    ).rejects.toBeInstanceOf(AdminBreakGlassTargetError);
    expect(f.tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('laesst einen Audit-Fehler die gemeinsame Transaktion verwerfen', async () => {
    const f = fixture();
    f.record.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      resetAdminAccessForBreakGlass({
        prisma: f.prisma,
        evidence: f.evidence,
        adminEmail: 'admin@example.test',
        tenantSlug: 'kanzlei',
        passwordHash: 'hash',
      }),
    ).rejects.toThrow('audit unavailable');
    expect(f.calls.at(-1)).toBe('transaction-rollback');
  });

  it('fuehrt die Recovery-Ausgabe vor dem Commit aus', async () => {
    const f = fixture();

    await expect(
      resetAdminAccessForBreakGlass({
        prisma: f.prisma,
        evidence: f.evidence,
        adminEmail: 'admin@example.test',
        tenantSlug: 'kanzlei',
        passwordHash: 'hash',
        beforeCommit: () => {
          f.calls.push('credential-output');
        },
      }),
    ).resolves.toBeDefined();
    expect(f.calls.slice(-3)).toEqual(['audit', 'credential-output', 'transaction-commit']);
  });

  it('laesst eine fehlgeschlagene Recovery-Ausgabe die Transaktion verwerfen', async () => {
    const f = fixture();

    await expect(
      resetAdminAccessForBreakGlass({
        prisma: f.prisma,
        evidence: f.evidence,
        adminEmail: 'admin@example.test',
        tenantSlug: 'kanzlei',
        passwordHash: 'hash',
        beforeCommit: () => {
          f.calls.push('credential-output');
          throw new Error('credential output rejected');
        },
      }),
    ).rejects.toThrow('credential output rejected');
    expect(f.calls.slice(-3)).toEqual(['audit', 'credential-output', 'transaction-rollback']);
  });
});
