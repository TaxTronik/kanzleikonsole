// =============================================================================
// „Erneut senden" für Mandanten-Mails (Review-Entscheidung C4)
//
// An den Statuszeilen eines Vorgangs kann die Kanzlei fehlgeschlagene (FAILED)
// und unklare (UNKNOWN) Versandaufträge erneut senden. Die Web-App sendet nie
// selbst: Sie setzt den Auftrag über app.mail_outbox_resend zurück nach QUEUED
// (Inhalt bleibt in FAILED/UNKNOWN dafür erhalten) und stößt den Worker an; der
// prüft vor dem Versand erneut den Vorgang. Vorher gelten:
//   - dasselbe Gate wie die Action, die die Mail ausgelöst hat (Einzelrecht,
//     Modul, Mandantenzugriff; bei der GwG-Begrüßung der Berufsträger),
//   - dieselbe Zustandsprüfung wie im Worker (checkMailOutboxRelevanceTx):
//     ist der Vorgang nicht mehr aktuell, endet der Auftrag als SKIPPED,
//   - bei unklarem Ausgang eine ausdrückliche Bestätigung, weil die Mail
//     möglicherweise bereits zugestellt wurde.
// Jeder Wechsel wird im selben Commit auditiert.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { checkMailOutboxRelevanceTx, type MailOutboxPurpose } from '@taxtronik/mail/outbox';
import { ActionError } from '@/server/actions/action-error';
import { audit } from '@/server/actions/audit';
import type { StaffCtx } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { canStaffReviewGwgTx } from '@/server/gwg/professional-review';

export { MAIL_RESEND_GUARDS } from './resend-guards';

export interface MailResendInput {
  purpose: MailOutboxPurpose;
  resourceType: string;
  resourceId: string;
  outboxIds: readonly string[];
  /** Bestätigung, dass eine möglicherweise zugestellte Mail erneut gesendet werden soll. */
  confirmUncertain: boolean;
}

export type MailResendOutcome =
  | { kind: 'requeued'; count: number }
  | { kind: 'skipped'; count: number; reason: string };

type ResendActor = Pick<StaffCtx, 'session' | 'tenantId' | 'staffId' | 'ctx'>;

const RESENDABLE = new Set(['FAILED', 'UNKNOWN']);

async function resendRowTx(
  tx: TxClient,
  row: { id: string; status: string },
  skipReason: string | null,
): Promise<boolean> {
  const [result] = await tx.$queryRaw<Array<{ ok: boolean }>>`
    SELECT app.mail_outbox_resend(
      ${row.id}::uuid,
      ${row.status}::public.mail_outbox_status,
      ${skipReason}::text
    ) AS ok
  `;
  return result?.ok === true;
}

async function assertResendAllowedTx(
  tx: TxClient,
  actor: ResendActor,
  input: MailResendInput,
  clientId: string,
): Promise<void> {
  await assertClientAccessTx(tx, actor.session, clientId);
  if (
    input.purpose === 'gwg-activated' &&
    !(await canStaffReviewGwgTx(tx, { tenantId: actor.tenantId, clientId, staffId: actor.staffId }))
  ) {
    throw new ActionError(
      'Nur der für diesen Mandanten zugeordnete Berufsträger darf die Begrüßungsmail erneut senden.',
    );
  }
}

/**
 * Setzt die angegebenen Aufträge eines Vorgangs für den Worker zurück oder
 * verwirft sie, wenn der Vorgang nicht mehr aktuell ist. Läuft in der
 * Tenant-Transaktion der Action (RLS, Audit im selben Commit).
 */
export async function resendMailOutboxTx(
  tx: TxClient,
  actor: ResendActor,
  input: MailResendInput,
  now: Date,
): Promise<MailResendOutcome> {
  const rows = await tx.mailOutbox.findMany({
    where: {
      id: { in: [...input.outboxIds] },
      tenantId: actor.tenantId,
      purpose: input.purpose,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    },
    select: {
      id: true,
      tenantId: true,
      clientId: true,
      purpose: true,
      resourceType: true,
      resourceId: true,
      status: true,
      attemptCount: true,
    },
  });
  if (rows.length !== new Set(input.outboxIds).size) {
    throw new ActionError('Der Versandauftrag wurde nicht gefunden. Bitte Seite neu laden.');
  }
  if (rows.some((row) => !RESENDABLE.has(row.status))) {
    throw new ActionError(
      'Nur fehlgeschlagene oder unklare Mails können erneut gesendet werden. Bitte Seite neu laden.',
    );
  }
  const [first] = rows;
  if (!first || rows.some((row) => row.clientId !== first.clientId)) {
    throw new ActionError('Der Versandauftrag wurde nicht gefunden. Bitte Seite neu laden.');
  }
  await assertResendAllowedTx(tx, actor, input, first.clientId);
  if (rows.some((row) => row.status === 'UNKNOWN') && !input.confirmUncertain) {
    throw new ActionError(
      'Bitte bestätigen Sie den erneuten Versand: Die Mail wurde möglicherweise bereits zugestellt.',
    );
  }

  // Dieselbe Prüfung wie der Worker vor jedem Versand (ein Vorgang je Statuszeile).
  const relevance = await checkMailOutboxRelevanceTx(tx, first, now);
  const skipReason = relevance.wanted ? null : relevance.reason;
  for (const row of rows) {
    if (!(await resendRowTx(tx, row, skipReason))) {
      throw new ActionError(
        'Die Mail kann nicht erneut gesendet werden: Ihr Status hat sich geändert oder der Inhalt wurde nach Ablauf der Aufbewahrung entfernt. Bitte Seite neu laden.',
      );
    }
    await audit(tx, actor, {
      action: skipReason ? 'mail_outbox.resend_skipped' : 'mail_outbox.resend',
      resourceType: 'mail_outbox',
      resourceId: row.id,
      before: {
        status: row.status,
        attemptCount: row.attemptCount,
        purpose: row.purpose,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
      },
      after: skipReason ? { status: 'SKIPPED', reason: skipReason } : { status: 'QUEUED' },
    });
  }
  return skipReason
    ? { kind: 'skipped', count: rows.length, reason: skipReason }
    : { kind: 'requeued', count: rows.length };
}
