// =============================================================================
// Auth-Ereignisse in der Audit-Hash-Chain (RF-12)
//
// Logins/Lockouts standen bisher nur in flüchtigen pino-Logs — das OPEN-
// Zugriffsmodell wird aber mit „der Audit-Trail trägt die Nachvollziehbarkeit"
// begründet; dann müssen auch Auth-Ereignisse manipulationsevident in der
// Chain stehen (auth.login.success/.failure/.lockout, auth.totp.enroll,
// auth.backup_code.consume — Labels in server/audit/labels.ts).
//
// Failure-Pfad: die fachliche Mutation (Fehlversuchszähler) läuft DI-rein in
// lockout.ts (eigene Unit-Tests, kein Container-Import dort möglich) — der
// Chain-Eintrag hier bekommt deshalb seine eigene kleine Tx; record()
// braucht ohnehin eine Transaktion (pg_advisory_xact_lock).
//
// WICHTIG (Anti-Enumeration): bei unbekannter E-Mail gibt es KEIN Audit-Event —
// ohne StaffUser ist der Tenant nicht sicher bestimmbar und es existiert kein
// Konto, dem das Ereignis zuzuordnen wäre. Die Call-Sites rufen diese Helfer
// deshalb erst NACH dem erfolgreichen User-Lookup auf.
// =============================================================================

import { prismaOwner } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';
import { recordFailedLogin, LOCK_DURATION_MS } from './lockout';

/** 'unknown' (Proxy-Fehlkonfiguration) ist kein gültiges inet → null. */
export function auditIp(ip: string | null | undefined): string | null {
  return ip && ip !== 'unknown' ? ip : null;
}

export type LoginFailureReason = 'password' | 'totp' | 'totp_replay' | 'backup_code_race';

/**
 * Fehlversuch zählen (Lockout-Logik in lockout.ts) + auth.login.failure und —
 * falls DIESER Versuch das Konto gesperrt hat — auth.login.lockout in die
 * Audit-Chain. actor = das betroffene Konto (account-gebundenes Ereignis).
 */
export async function recordFailedLoginAudited(opts: {
  tenantId: string;
  staffUserId: string;
  email: string;
  ip: string | null;
  reason: LoginFailureReason;
}): Promise<void> {
  const { locked } = await recordFailedLogin(prismaOwner, opts.staffUserId, opts.ip);
  await prismaOwner.$transaction(async (tx) => {
    await evidenceService.record(tx, {
      tenantId: opts.tenantId,
      actorType: 'STAFF',
      actorId: opts.staffUserId,
      action: 'auth.login.failure',
      resourceType: 'staff_user',
      resourceId: opts.staffUserId,
      after: { email: opts.email, reason: opts.reason },
      ip: auditIp(opts.ip),
    });
    if (locked) {
      await evidenceService.record(tx, {
        tenantId: opts.tenantId,
        actorType: 'STAFF',
        actorId: opts.staffUserId,
        action: 'auth.login.lockout',
        resourceType: 'staff_user',
        resourceId: opts.staffUserId,
        after: { email: opts.email, lockMinutes: LOCK_DURATION_MS / 60_000 },
        ip: auditIp(opts.ip),
      });
    }
  });
}
