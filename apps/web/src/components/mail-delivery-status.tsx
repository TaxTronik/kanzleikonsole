// =============================================================================
// Zustellstatus einer Mandanten-Mail am Vorgang (Review-Befund F-08)
//
// Zeigt statt eines pauschalen „versendet" den Stand des Versandauftrags aus
// der Mail-Outbox. „Angenommen" heißt technisch vom Versanddienst übernommen —
// kein Zugangs- oder Kenntnisnahmenachweis (Tooltip).
// =============================================================================

import {
  MAIL_OUTBOX_PURPOSE_LABELS,
  type MailOutboxPurpose,
} from '@taxtronik/mail/outbox-purposes';
import {
  MAIL_DELIVERY_STATE_HINTS,
  MAIL_DELIVERY_STATE_LABELS,
  type MailDeliveryState,
  type MailDeliverySummary,
} from '@/lib/mail-delivery-status';

const STATE_CLASSES: Readonly<Record<MailDeliveryState, string>> = {
  pending: 'text-muted',
  retrying: 'text-amber-700 dark:text-amber-300',
  accepted: 'text-emerald-700 dark:text-emerald-300',
  partial: 'text-amber-700 dark:text-amber-300',
  'no-recipient': 'text-muted',
  failed: 'text-red-700 dark:text-red-300',
  unknown: 'text-amber-700 dark:text-amber-300',
};

function purposeLabel(purpose: string): string {
  return MAIL_OUTBOX_PURPOSE_LABELS[purpose as MailOutboxPurpose] ?? 'E-Mail';
}

function recipientCount(summary: MailDeliverySummary): string {
  if (summary.attempted <= 1) return '';
  if (summary.state === 'accepted') return ` (${summary.attempted} Empfänger)`;
  if (summary.state === 'partial') return ` (${summary.accepted} von ${summary.attempted})`;
  return '';
}

export function MailDeliveryStatus({ summary }: { summary: MailDeliverySummary }) {
  return (
    <span
      className={STATE_CLASSES[summary.state]}
      title={MAIL_DELIVERY_STATE_HINTS[summary.state]}
      data-mail-delivery={summary.state}
    >
      {purposeLabel(summary.purpose)}: {MAIL_DELIVERY_STATE_LABELS[summary.state]}
      {recipientCount(summary)}
    </span>
  );
}

/** Alle Anlässe eines Vorgangs untereinander; ohne Aufträge nichts. */
export function MailDeliveryStatusList({
  summaries,
  className = 'text-xs',
}: {
  summaries: readonly MailDeliverySummary[] | undefined;
  className?: string;
}) {
  if (!summaries || summaries.length === 0) return null;
  return (
    <ul className={className} aria-label="Zustellstatus der Mandanten-E-Mails">
      {summaries.map((summary) => (
        <li key={summary.purpose}>
          <MailDeliveryStatus summary={summary} />
        </li>
      ))}
    </ul>
  );
}
