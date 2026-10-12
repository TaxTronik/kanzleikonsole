// =============================================================================
// Mandanten-Mails zu geänderten und abgesagten Terminen mit Zustellstatus
// (Welle 15)
//
// Wie „Entschiedene Terminanfragen“ (decided-requests.tsx): Der Kalender zeigt
// die Terminänderungs- und Absagemails der letzten Tage mit dem Stand ihres
// Versandauftrags; fehlgeschlagene oder unklare lassen sich dort erneut senden.
// =============================================================================

import { CalendarClock } from 'lucide-react';
import { MailDeliveryStatusList } from '@/components/mail-delivery-status';
import type { MailDeliverySummary } from '@/lib/mail-delivery-status';
import { fmtDateTimeShort } from '@/lib/fmt';

export interface AppointmentMailRow {
  id: string;
  title: string;
  clientName: string | null;
  status: 'PLANNED' | 'CONFIRMED' | 'CANCELLED' | 'DONE';
  startsAt: Date;
  mail: readonly MailDeliverySummary[];
}

export function AppointmentMails({
  appointments,
  days,
}: {
  appointments: readonly AppointmentMailRow[];
  days: number;
}) {
  if (appointments.length === 0) return null;
  return (
    <div className="card overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-default flex items-center gap-2">
        <CalendarClock aria-hidden="true" className="h-4 w-4 text-muted" />
        <h2 className="text-sm font-medium text-primary">
          Mandanten-Mails zu Terminänderungen (letzte {days} Tage)
        </h2>
      </div>
      <ul className="divide-y divide-border-subtle">
        {appointments.map((appointment) => (
          <li key={appointment.id} className="px-5 py-3" data-appointment-mail={appointment.id}>
            <p className="text-sm text-primary break-words">
              <span className="font-medium">{appointment.title}</span>
              {appointment.clientName ? (
                <span className="text-muted"> · {appointment.clientName}</span>
              ) : null}
            </p>
            <p className="text-xs text-muted">
              {appointment.status === 'CANCELLED' ? 'abgesagt · ' : ''}
              {fmtDateTimeShort(appointment.startsAt)}
            </p>
            <MailDeliveryStatusList summaries={appointment.mail} className="mt-1 text-xs" />
          </li>
        ))}
      </ul>
    </div>
  );
}
