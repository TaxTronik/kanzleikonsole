import Link from 'next/link';
import type { ReminderDetail } from '@/server/reminders/detail';

export function ticketHistoryHref(
  detail: ReminderDetail,
  changes: { commentsPage?: number; attachmentsPage?: number },
): string {
  const params = new URLSearchParams();
  const commentsPage = changes.commentsPage ?? detail.commentsPage;
  const attachmentsPage = changes.attachmentsPage ?? detail.attachmentsPage;
  if (commentsPage > 1) params.set('commentsPage', String(commentsPage));
  if (attachmentsPage > 1) params.set('attachmentsPage', String(attachmentsPage));
  return `/staff/reminders/${detail.ticketNumber}${params.size ? `?${params}` : ''}`;
}

/** REMINDER-TICKET-001: Auch frühere Kommentare und Anhänge bleiben erreichbar. */
export function TicketHistoryPagination({
  detail,
  kind,
}: {
  detail: ReminderDetail;
  kind: 'comments' | 'attachments';
}) {
  const page = kind === 'comments' ? detail.commentsPage : detail.attachmentsPage;
  const total = kind === 'comments' ? detail.commentsTotal : detail.attachmentsTotal;
  const size = kind === 'comments' ? detail.commentsPageSize : detail.attachmentsPageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  const label = kind === 'comments' ? 'Kommentare' : 'Anhänge';
  const href = (next: number) =>
    ticketHistoryHref(
      detail,
      kind === 'comments' ? { commentsPage: next } : { attachmentsPage: next },
    );
  return (
    <nav
      aria-label={`${label} blättern`}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-default pt-3 text-xs text-muted"
    >
      <span>
        {total} {label}
        {pages > 1 ? ` · Seite ${page} von ${pages} (neueste zuerst)` : ''}
      </span>
      <div className="flex gap-3">
        {page > 1 && (
          <Link href={href(page - 1)} className="text-brand-600 hover:underline">
            Neuere
          </Link>
        )}
        {page < pages && (
          <Link href={href(page + 1)} className="text-brand-600 hover:underline">
            Ältere
          </Link>
        )}
      </div>
    </nav>
  );
}
