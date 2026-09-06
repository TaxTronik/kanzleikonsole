import type { TxClient } from '@taxtronik/db';

/**
 * Nimmt denselben transaktionsweiten Lock wie die DB-Trigger fuer
 * Staff-Hardwaremodus und Credential-Aenderungen. Dieser unprivilegierte
 * Helfer wird fuer den eigenen Opt-in verwendet; Autorisierung und Tenant-
 * Scope bleiben bei Action und RLS.
 */
export async function lockStaffHardwareAuthState(
  tx: TxClient,
  tenantId: string,
  staffUserId: string,
): Promise<void> {
  const lockKey = `staff-hardware-auth:${tenantId}:${staffUserId}`;
  await tx.$queryRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${lockKey}, 0)
    )::TEXT AS "locked"
  `;
}

/**
 * Serialisiert Recovery und Rollenwechsel fuer dasselbe Staff-Konto.
 * Der DB-Trigger auf staff_role verwendet exakt denselben Advisory Lock.
 */
export async function lockStaffAccountRecovery(tx: TxClient, staffUserId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT app.lock_staff_account_recovery(${staffUserId}::UUID)::TEXT AS "locked"
  `;
}

/**
 * Widerruft fremde Hardware-Credentials ausschliesslich ueber den
 * DB-erzwungenen Break-glass-Pfad. Die Funktion prueft Tenant, Rollen-
 * Hierarchie und Hardware-only-Zustand nach Erwerb desselben Advisory Locks.
 */
export async function revokeStaffHardwareCredentialsForRecovery(
  tx: TxClient,
  staffUserId: string,
): Promise<number> {
  const [result] = await tx.$queryRaw<Array<{ revokedCount: number }>>`
    SELECT app.revoke_staff_webauthn_credentials_for_recovery(
      ${staffUserId}::UUID
    ) AS "revokedCount"
  `;
  return result?.revokedCount ?? 0;
}

/**
 * Widerruft bei Passwort-/TOTP-Sicherheitsresets auch noch nicht aktivierte
 * Hardware-Credentials. Die DB-Funktion erzwingt dieselbe Rollen-Hierarchie
 * und globale Lock-Reihenfolge wie der Hardware-only-Recovery-Pfad.
 */
export async function revokeStaffHardwareCredentialsForSecurityReset(
  tx: TxClient,
  staffUserId: string,
  actorAuthRevision: number,
): Promise<number> {
  const [result] = await tx.$queryRaw<Array<{ revokedCount: number }>>`
    SELECT app.revoke_staff_webauthn_credentials_for_security_reset(
      ${staffUserId}::UUID,
      ${actorAuthRevision}::INTEGER
    ) AS "revokedCount"
  `;
  return result?.revokedCount ?? 0;
}
