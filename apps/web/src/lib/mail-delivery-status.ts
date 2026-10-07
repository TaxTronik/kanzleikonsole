// =============================================================================
// Zustellstatus von Mandanten-Mails am Vorgang (Review-Befund F-08)
//
// Reine Zusammenfassung der mail_outbox-Aufträge eines Vorgangs (ohne DB- und
// Krypto-Abhängigkeit, damit sie in Server- und Client-Komponenten nutzbar
// ist). Je Anlass:
//   - Einzelmails (DIRECT) gehen je Vorgang genau einmal hinaus, ggf. an
//     mehrere Adressen (Rechnungsmail) — alle Aufträge zählen zusammen.
//   - Kontaktmails (CLIENT_CONTACTS) können sich wiederholen (jede
//     Kanzlei-Antwort) — maßgeblich ist der jüngste Auftrag.
//   - Vor dem Versand verworfene Aufträge (SKIPPED: Vorgang erledigt,
//     zurückgezogen oder abgesagt) zählen nur, wenn alle Aufträge des Anlasses
//     verworfen wurden.
// =============================================================================

export type MailOutboxStatusValue =
  | 'QUEUED'
  | 'SENDING'
  | 'RETRY_PENDING'
  | 'PROVIDER_ACCEPTED'
  | 'PARTIAL_FAILURE'
  | 'NO_RECIPIENT'
  | 'FAILED'
  | 'UNKNOWN'
  | 'SKIPPED';

export interface MailOutboxStatusRow {
  /** Auftrags-ID; nur für „Erneut senden" nötig. */
  id?: string;
  purpose: string;
  kind: 'DIRECT' | 'CLIENT_CONTACTS';
  status: MailOutboxStatusValue;
  recipientsAttempted: number | null;
  recipientsAccepted: number | null;
  createdAt: Date;
  /** Begründung eines verworfenen Auftrags (`last_error` bei SKIPPED). */
  lastError?: string | null;
  /** C4: FAILED/UNKNOWN mit erhaltenem Inhalt — „Erneut senden" ist möglich. */
  resendable?: boolean;
}

/** Vorgang, an dem die Statuszeile steht. */
export interface MailDeliveryResource {
  resourceType: string;
  resourceId: string;
}

/** C4: Aufträge einer Statuszeile, die „Erneut senden" zurücksetzen würde. */
export interface MailResendTarget extends MailDeliveryResource {
  purpose: string;
  outboxIds: string[];
  /** Mindestens ein unklarer Auftrag: die Mail wurde möglicherweise schon zugestellt. */
  uncertain: boolean;
}

export type MailDeliveryState =
  | 'pending'
  | 'retrying'
  | 'accepted'
  | 'partial'
  | 'no-recipient'
  | 'failed'
  | 'unknown'
  | 'skipped';

export interface MailDeliverySummary {
  purpose: string;
  state: MailDeliveryState;
  /** Vom Versanddienst angenommene Einzelversuche. */
  accepted: number;
  /** Adressierte Empfänger, soweit bereits bekannt. */
  attempted: number;
  /** Nur bei `skipped`: warum die Mail nicht versendet wurde. */
  skippedReason?: string;
  /** Nur wenn fehlgeschlagene oder unklare Aufträge erneut gesendet werden können. */
  resend?: MailResendTarget;
}

const PENDING: ReadonlySet<MailOutboxStatusValue> = new Set(['QUEUED', 'SENDING']);

function aggregateState(rows: readonly MailOutboxStatusRow[]): MailDeliveryState {
  const has = (status: MailOutboxStatusValue) => rows.some((row) => row.status === status);
  if (rows.some((row) => PENDING.has(row.status))) return 'pending';
  if (has('RETRY_PENDING')) return 'retrying';
  if (has('UNKNOWN')) return 'unknown';
  if (has('PARTIAL_FAILURE')) return 'partial';
  if (has('FAILED')) return has('PROVIDER_ACCEPTED') ? 'partial' : 'failed';
  if (rows.every((row) => row.status === 'NO_RECIPIENT')) return 'no-recipient';
  return 'accepted';
}

function attemptedOf(row: MailOutboxStatusRow): number {
  return row.recipientsAttempted ?? (row.kind === 'DIRECT' ? 1 : 0);
}

/** Begründung ohne das technische Präfix des Workers. */
function skippedReason(rows: readonly MailOutboxStatusRow[]): string | undefined {
  const reason = rows.find((row) => row.lastError)?.lastError ?? undefined;
  return reason?.replace(/^Nicht versendet:\s*/, '') || undefined;
}

function resendTarget(
  purpose: string,
  rows: readonly MailOutboxStatusRow[],
  resource: MailDeliveryResource | undefined,
): MailResendTarget | undefined {
  const resendable = rows.filter(
    (row): row is MailOutboxStatusRow & { id: string } =>
      Boolean(row.resendable && row.id) && (row.status === 'FAILED' || row.status === 'UNKNOWN'),
  );
  if (!resource || resendable.length === 0) return undefined;
  return {
    purpose,
    ...resource,
    outboxIds: resendable.map((row) => row.id),
    uncertain: resendable.some((row) => row.status === 'UNKNOWN'),
  };
}

function summarizeBatch(
  purpose: string,
  batch: readonly MailOutboxStatusRow[],
  resource: MailDeliveryResource | undefined,
): MailDeliverySummary {
  const counted = batch.filter((row) => row.status !== 'SKIPPED');
  if (counted.length === 0) {
    const reason = skippedReason(batch);
    return {
      purpose,
      state: 'skipped' as const,
      accepted: 0,
      attempted: 0,
      ...(reason ? { skippedReason: reason } : {}),
    };
  }
  const resend = resendTarget(purpose, counted, resource);
  return {
    purpose,
    state: aggregateState(counted),
    accepted: counted.reduce((sum, row) => sum + (row.recipientsAccepted ?? 0), 0),
    attempted: counted.reduce((sum, row) => sum + attemptedOf(row), 0),
    ...(resend ? { resend } : {}),
  };
}

/**
 * Je Anlass eine Zusammenfassung, in der Reihenfolge des ersten Auftretens.
 * Mit `resource` erhält eine Zeile mit erneut sendbaren Aufträgen ein
 * `resend`-Ziel (C4); ohne bleibt die Anzeige rein lesend.
 */
export function summarizeMailDelivery(
  rows: readonly MailOutboxStatusRow[],
  resource?: MailDeliveryResource,
): MailDeliverySummary[] {
  const byPurpose = new Map<string, MailOutboxStatusRow[]>();
  for (const row of rows) {
    const batch = byPurpose.get(row.purpose);
    if (!batch) {
      byPurpose.set(row.purpose, [row]);
    } else if (row.kind === 'DIRECT') {
      batch.push(row);
    } else if (row.createdAt.getTime() > batch[0]!.createdAt.getTime()) {
      byPurpose.set(row.purpose, [row]);
    }
  }
  return [...byPurpose.entries()].map(([purpose, batch]) =>
    summarizeBatch(purpose, batch, resource),
  );
}

export const MAIL_DELIVERY_STATE_LABELS: Readonly<Record<MailDeliveryState, string>> = {
  pending: 'wird zugestellt',
  retrying: 'erneuter Zustellversuch geplant',
  accepted: 'vom Versanddienst angenommen',
  partial: 'nur teilweise angenommen – bitte prüfen',
  'no-recipient': 'nicht versendet – kein bestätigter Kontakt mit Benachrichtigungen',
  failed: 'Versand fehlgeschlagen – bitte prüfen',
  unknown: 'Versandstatus unklar – bitte prüfen',
  skipped: 'nicht versendet – Vorgang nicht mehr aktuell',
};

/** Tooltip: Annahme durch den Versanddienst ist kein Zugangsnachweis. */
export const MAIL_DELIVERY_STATE_HINTS: Readonly<Record<MailDeliveryState, string>> = {
  pending: 'Der Versandauftrag ist gespeichert und wird vom Hintergrunddienst zugestellt.',
  retrying:
    'Der letzte Versuch wurde eindeutig abgelehnt; TaxTronik versucht es automatisch erneut.',
  accepted:
    'Der Versanddienst hat die Mail technisch angenommen. Das ist kein Zugangs- oder Kenntnisnahmenachweis.',
  partial:
    'Nicht alle Empfänger wurden angenommen. Wegen des Doppelversandrisikos wird nicht automatisch erneut gesendet.',
  'no-recipient':
    'Es gibt keinen aktiven, per Portal-Login bestätigten Kontakt mit eingeschalteten Benachrichtigungen.',
  failed: 'Nach mehreren eindeutig gescheiterten Versuchen wurde der automatische Versand beendet.',
  unknown:
    'Der Versandausgang ist nicht eindeutig bestimmbar. Wegen des Doppelversandrisikos wird nicht automatisch erneut gesendet.',
  skipped:
    'Vor dem Versand war der Vorgang bereits erledigt, zurückgezogen oder abgesagt; die Mail wurde deshalb nicht gesendet.',
};
