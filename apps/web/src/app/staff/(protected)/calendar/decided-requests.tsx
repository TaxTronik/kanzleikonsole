// =============================================================================
// Entschiedene Terminanfragen mit Zustellstatus (Review-Entscheidung C4)
//
// Nach Annehmen oder Ablehnen verschwindet eine Anfrage aus „Offene
// Terminanfragen". Damit der Stand der Bestätigungs- bzw. Absagemail dort
// sichtbar bleibt, wo sie ausgelöst wurde, listet der Kalender die Entscheidungen
// der letzten Tage mit Zustellstatus und „Erneut senden".
// =============================================================================

import { MailCheck } from 'lucide-react';
import { MailDeliveryStatusList } from '@/components/mail-delivery-status';
import type { MailDeliverySummary } from '@/lib/mail-delivery-status';
import { fmtDateTimeShort } from '@/lib/fmt';

export interface DecidedRequestRow {
  id: string;
  subject: string;
  clientName: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  decidedAt: Date | null;
  mail: readonly MailDeliverySummary[];
}

const DECISION_LABEL: Readonly<Record<string, string>> = {
  ACCEPTED: 'angenommen',
  REJECTED: 'abgelehnt',
};

export function DecidedRequests({
  requests,
  days,
}: {
  requests: readonly DecidedRequestRow[];
  days: number;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="card overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-default flex items-center gap-2">
        <MailCheck aria-hidden="true" className="h-4 w-4 text-muted" />
        <h2 className="text-sm font-medium text-primary">
          Entschiedene Terminanfragen (letzte {days} Tage)
        </h2>
      </div>
      <ul className="divide-y divide-border-subtle">
        {requests.map((request) => (
          <li key={request.id} className="px-5 py-3" data-decided-request={request.id}>
            <p className="text-sm text-primary break-words">
              <span className="font-medium">{request.subject}</span>
              <span className="text-muted"> · {request.clientName}</span>
            </p>
            <p className="text-xs text-muted">
              {DECISION_LABEL[request.status] ?? request.status}
              {request.decidedAt ? ` am ${fmtDateTimeShort(request.decidedAt)}` : ''}
            </p>
            {request.mail.length > 0 ? (
              <MailDeliveryStatusList summaries={request.mail} className="mt-1 text-xs" />
            ) : (
              <p className="mt-1 text-xs text-muted">
                Keine Mail – der anfragende Kontakt ist inaktiv oder hat keine Benachrichtigungen
                aktiviert.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
