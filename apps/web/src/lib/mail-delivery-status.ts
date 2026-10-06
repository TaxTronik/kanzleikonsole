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
// =============================================================================

export type MailOutboxStatusValue =
  | 'QUEUED'
  | 'SENDING'
  | 'RETRY_PENDING'
  | 'PROVIDER_ACCEPTED'
  | 'PARTIAL_FAILURE'
  | 'NO_RECIPIENT'
  | 'FAILED'
  | 'UNKNOWN';

export interface MailOutboxStatusRow {
  purpose: string;
  kind: 'DIRECT' | 'CLIENT_CONTACTS';
  status: MailOutboxStatusValue;
  recipientsAttempted: number | null;
  recipientsAccepted: number | null;
  createdAt: Date;
}

export type MailDeliveryState =
  | 'pending'
  | 'retrying'
  | 'accepted'
  | 'partial'
  | 'no-recipient'
  | 'failed'
  | 'unknown';

export interface MailDeliverySummary {
  purpose: string;
  state: MailDeliveryState;
  /** Vom Versanddienst angenommene Einzelversuche. */
  accepted: number;
  /** Adressierte Empfänger, soweit bereits bekannt. */
  attempted: number;
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

/** Je Anlass eine Zusammenfassung, in der Reihenfolge des ersten Auftretens. */
export function summarizeMailDelivery(rows: readonly MailOutboxStatusRow[]): MailDeliverySummary[] {
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
  return [...byPurpose.entries()].map(([purpose, batch]) => ({
    purpose,
    state: aggregateState(batch),
    accepted: batch.reduce((sum, row) => sum + (row.recipientsAccepted ?? 0), 0),
    attempted: batch.reduce((sum, row) => sum + attemptedOf(row), 0),
  }));
}

export const MAIL_DELIVERY_STATE_LABELS: Readonly<Record<MailDeliveryState, string>> = {
  pending: 'wird zugestellt',
  retrying: 'erneuter Zustellversuch geplant',
  accepted: 'vom Versanddienst angenommen',
  partial: 'nur teilweise angenommen – bitte prüfen',
  'no-recipient': 'nicht versendet – kein bestätigter Kontakt mit Benachrichtigungen',
  failed: 'Versand fehlgeschlagen – bitte prüfen',
  unknown: 'Versandstatus unklar – bitte prüfen',
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
};
