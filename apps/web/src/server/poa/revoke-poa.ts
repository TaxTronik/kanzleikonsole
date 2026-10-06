// =============================================================================
// Widerruf einer Vollmacht (Review-Finding K-03).
//
// Fachkatalog: POA-LIFECYCLE-001, POA-SIGNING-CONFIRMATION-001
//
// Läuft in der Transaktion der Action (withStaff); das ADMIN/PARTNER-Gate
// prüft die Action vorher in derselben Transaktion.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { ActionError, type StaffCtx } from '@/server/actions/staff-action';

export interface RevokePoaInput {
  poaId: string;
  reason: string;
}

/**
 * Sperrt die Vollmacht, prüft Zugriff und Status und widerruft sie atomar mit
 * der Datenbank-Uhr (Status, Begründung, Token-Entwertung); danach werden ihre
 * Benachrichtigungen erledigt und der Widerruf auditiert.
 */
export async function revokePoaTx(
  tx: TxClient,
  { tenantId, staffId, session }: Pick<StaffCtx, 'tenantId' | 'staffId' | 'session'>,
  { poaId, reason }: RevokePoaInput,
): Promise<void> {
  // Die Zeile wird vor Berechtigungsprüfung und Widerruf gesperrt. So
  // startet das folgende UPDATE erst nach einem eventuell konkurrierenden
  // Signatur-/Widerrufsvorgang und seine statement_timestamp()-Zeit kann
  // nicht hinter einem gerade geschriebenen signed_at liegen.
  const [before] = await tx.$queryRaw<Array<{ clientId: string; status: string }>>`
    SELECT "client_id" AS "clientId", "status"::text AS "status"
      FROM "power_of_attorney"
     WHERE "id" = ${poaId}::uuid
       AND "tenant_id" = ${tenantId}::uuid
     FOR UPDATE
  `;
  if (!before) throw new ActionError('Vollmacht nicht gefunden.');
  await assertClientAccessTx(tx, session, before.clientId);
  if (before.status === 'REVOKED') throw new ActionError('Bereits widerrufen.');
  // Der Trigger vergleicht revoked_at mit DB-generierten Lebenszykluszeiten.
  // Deshalb muss auch der Widerruf in genau diesem UPDATE von der DB-Uhr
  // stammen; eine JS-Date würde bei Host-/DB-Uhrabweichung sporadisch als
  // rückdatiert erscheinen. Das einzelne Statement bleibt zugleich
  // atomar mit Statuswechsel, Begründung und Token-Entwertung.
  const [updated] = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "power_of_attorney"
       SET "status" = 'REVOKED',
           "revoked_at" = statement_timestamp(),
           "revoked_reason" = ${reason},
           "signing_token_hash" = NULL,
           "signing_otp_hash" = NULL,
           "updated_at" = statement_timestamp()
     WHERE "id" = ${poaId}::uuid
       AND "tenant_id" = ${tenantId}::uuid
       AND "status" <> 'REVOKED'
     RETURNING "id"
  `;
  if (!updated) {
    throw new ActionError('Vollmacht konnte nicht widerrufen werden. Bitte laden Sie neu.');
  }
  await resolveNotificationsTx(tx, {
    tenantId,
    resources: [{ resourceType: 'power_of_attorney', resourceId: updated.id }],
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'poa.revoke',
    resourceType: 'power_of_attorney',
    resourceId: updated.id,
    after: { reason },
  });
}
