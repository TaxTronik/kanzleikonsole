import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { EvidenceService } from '@taxtronik/evidence';
import { lockStaffHardwareAuthState } from './staff-account-recovery-lock';

type AuditRecorder = Pick<EvidenceService, 'record'>;

export class AdminBreakGlassTargetError extends Error {}

function syncParentDirectory(target: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(dirname(target), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type FileIdentity = { dev: number; ino: number };

function writeAdminBreakGlassFileContents(
  descriptor: number,
  email: string,
  password: string,
): void {
  // Der Erstellungsmodus unterliegt der umask. Der Descriptor vermeidet
  // einen Pfadwechsel zwischen chmod, Schreiben und fsync.
  fchmodSync(descriptor, 0o600);
  if (process.platform !== 'win32' && (fstatSync(descriptor).mode & 0o777) !== 0o600) {
    throw new Error('Recovery-Datei konnte nicht mit Modus 0600 abgesichert werden.');
  }

  const contents = Buffer.from(`email=${email}\npassword=${password}\n`, 'utf8');
  let offset = 0;
  while (offset < contents.byteLength) {
    const written = writeSync(descriptor, contents, offset, contents.byteLength - offset);
    if (written <= 0) {
      throw new Error('Recovery-Datei konnte nicht vollstaendig geschrieben werden.');
    }
    offset += written;
  }
  fsyncSync(descriptor);
}

function cleanupPartialAdminBreakGlassFile(
  target: string,
  identity: FileIdentity | undefined,
): unknown {
  if (!identity) return undefined;
  let cleanupFailure: unknown;
  let removed = false;
  try {
    const current = lstatSync(target);
    // Nur genau die per O_EXCL angelegte Datei entfernen. Ein nachtraeglich
    // ausgetauschtes Ziel wird niemals anhand des Pfads geloescht.
    if (current.dev === identity.dev && current.ino === identity.ino) {
      unlinkSync(target);
      removed = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailure = error;
  }
  if (removed) {
    try {
      syncParentDirectory(target);
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  return cleanupFailure;
}

export interface AdminBreakGlassResult {
  email: string;
  tenantSlug: string;
  revokedHardwareKeys: number;
}

/**
 * Legt die einmalige Recovery-Datei ohne Folgen oder Ueberschreiben eines
 * vorhandenen Pfads an. O_EXCL schuetzt auch dann, wenn das Ziel ein Symlink
 * ist; O_NOFOLLOW verstaerkt dies auf POSIX-Systemen.
 *
 * Fachkatalog: ACCESS-TENANT-RLS-001
 */
export function writeAdminBreakGlassCredentials(input: {
  target: string;
  email: string;
  password: string;
}): string {
  const target = resolve(input.target);
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let descriptor: number | undefined;
  let identity: FileIdentity | undefined;
  let failure: unknown;

  try {
    descriptor = openSync(target, flags, 0o600);
    const opened = fstatSync(descriptor);
    identity = { dev: opened.dev, ino: opened.ino };
    writeAdminBreakGlassFileContents(descriptor, input.email, input.password);
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure === undefined) {
    try {
      // fsync(file) persistiert nicht zwingend den neu angelegten
      // Directory-Eintrag. Der Parent wird deshalb noch vor dem DB-Commit
      // synchronisiert (POSIX; Windows besitzt hier keinen Directory-fsync).
      syncParentDirectory(target);
    } catch (error) {
      failure = error;
    }
  }

  if (failure !== undefined) {
    const cleanupFailure = cleanupPartialAdminBreakGlassFile(target, identity);
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [failure, cleanupFailure],
        'Recovery-Datei fehlgeschlagen und konnte nicht sicher bereinigt werden.',
      );
    }
    throw failure;
  }

  return target;
}

/**
 * Owner-CLI-Recovery fuer genau ein vorgegebenes ADMIN-Konto.
 *
 * Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
 */
export async function resetAdminAccessForBreakGlass(input: {
  prisma: PrismaClient;
  evidence: AuditRecorder;
  adminEmail: string;
  tenantSlug: string;
  passwordHash: string;
  now?: Date;
  beforeCommit?: (result: AdminBreakGlassResult) => void | Promise<void>;
}): Promise<AdminBreakGlassResult> {
  return input.prisma.$transaction(async (tx) => {
    const candidates = await tx.staffUser.findMany({
      where: {
        email: input.adminEmail,
        tenant: { slug: input.tenantSlug },
        roles: { some: { role: 'ADMIN' } },
      },
      select: {
        id: true,
        tenantId: true,
        email: true,
        tenant: { select: { slug: true } },
      },
      orderBy: [{ tenant: { slug: 'asc' } }, { email: 'asc' }],
    });
    if (candidates.length !== 1 || !candidates[0]) {
      throw new AdminBreakGlassTargetError(
        candidates.length === 0
          ? 'Kein passendes ADMIN-Konto gefunden. Es wurde nichts veraendert.'
          : 'Mehrere passende ADMIN-Konten gefunden. Es wurde nichts veraendert.',
      );
    }

    const candidate = candidates[0];
    // Derselbe Lock wird von Rollen-, Hardwaremodus- und Credential-Mutationen
    // verwendet. Der anschliessende Read ist deshalb die entscheidende,
    // aktuelle Autorisierungspruefung.
    await lockStaffHardwareAuthState(tx, candidate.tenantId, candidate.id);
    const current = await tx.staffUser.findFirst({
      where: {
        id: candidate.id,
        tenantId: candidate.tenantId,
        email: input.adminEmail,
        tenant: { slug: input.tenantSlug },
        roles: { some: { role: 'ADMIN' } },
      },
      select: {
        id: true,
        tenantId: true,
        email: true,
        hardwareOnlyEnabledAt: true,
        tenant: { select: { slug: true } },
      },
    });
    if (!current) {
      throw new AdminBreakGlassTargetError(
        'Das ADMIN-Konto wurde parallel geaendert. Es wurde nichts veraendert.',
      );
    }

    const activeSecurityKeys = await tx.staffWebAuthnCredential.count({
      where: { staffUserId: current.id, tenantId: current.tenantId, revokedAt: null },
    });
    const updated = await tx.staffUser.updateMany({
      where: {
        id: current.id,
        tenantId: current.tenantId,
        email: input.adminEmail,
        roles: { some: { role: 'ADMIN' } },
      },
      data: {
        passwordHash: input.passwordHash,
        active: true,
        lockedUntil: null,
        failedLoginCount: 0,
        hardwareOnlyEnabledAt: null,
        authRevision: { increment: 1 },
        totpSecretEnc: null,
        totpEnrolledAt: null,
        totpSetupStartedAt: null,
        totpBackupCodes: Prisma.DbNull,
      },
    });
    if (updated.count !== 1) {
      throw new AdminBreakGlassTargetError(
        'Das ADMIN-Konto wurde parallel geaendert. Es wurde nichts veraendert.',
      );
    }
    const revoked = await tx.staffWebAuthnCredential.updateMany({
      where: { staffUserId: current.id, tenantId: current.tenantId, revokedAt: null },
      data: { revokedAt: input.now ?? new Date() },
    });
    await input.evidence.record(tx, {
      tenantId: current.tenantId,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'staff.hardware_access.reset',
      resourceType: 'staff_user',
      resourceId: current.id,
      before: {
        mode: current.hardwareOnlyEnabledAt ? 'hardware_only' : 'password_totp',
        activeSecurityKeys,
      },
      after: {
        mode: 'password_totp_setup_required',
        activeSecurityKeys: 0,
        changedBy: 'owner_cli',
      },
    });

    const result = {
      email: current.email,
      tenantSlug: current.tenant.slug,
      revokedHardwareKeys: revoked.count,
    };
    // Prisma committet erst nach erfolgreicher Rueckkehr des Callbacks. Damit
    // rollt ein unsicherer oder fehlgeschlagener Credential-Export den Reset
    // samt Audit-Eintrag zurueck.
    await input.beforeCommit?.(result);
    return result;
  });
}
