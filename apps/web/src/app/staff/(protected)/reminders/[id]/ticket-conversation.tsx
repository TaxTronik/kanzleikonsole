'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Send } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import type { ReminderDetail } from '@/server/reminders/detail';
import { addReminderNoteAction } from '../../clients/[id]/reminders/actions';
import { TicketText } from '../ticket-text';
import { useMounted } from '../use-mounted';
import { MentionTextarea } from './mention-textarea';
import { TicketHistoryPagination, ticketHistoryHref } from './ticket-history-pagination';

export function TicketConversation({
  detail,
  staffOptions,
}: {
  detail: ReminderDetail;
  staffOptions: Array<{ id: string; fullName: string }>;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const mounted = useMounted();
  const entries = [...detail.discussion].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  function submit() {
    const submitted = note;
    setError(null);
    start(async () => {
      try {
        const result = await addReminderNoteAction({ id: detail.id, body: submitted });
        if (!mounted.current) return;
        if (result.ok) {
          setNote((current) => (current === submitted ? '' : current));
          if (detail.commentsPage > 1) router.push(ticketHistoryHref(detail, { commentsPage: 1 }));
          else router.refresh();
        } else setError(result.error ?? 'Kommentar konnte nicht gesendet werden.');
      } catch {
        if (mounted.current)
          setError('Kommentar konnte nicht gesendet werden. Bitte erneut versuchen.');
      }
    });
  }
  return (
    <section aria-label="Unterhaltung" className="card p-4 space-y-3">
      <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-disabled" />
        Unterhaltung ({detail.commentsTotal})
      </h2>
      {entries.length === 0 ? (
        <p className="text-xs text-disabled">Noch keine Kommentare.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded bg-surface-raised px-3 py-2">
              <p className="text-[11px] text-muted inline-flex items-center gap-1">
                {entry.staffName} · {fmtDateTimeShort(new Date(entry.createdAt))}
              </p>
              <p className="text-sm text-secondary whitespace-pre-wrap break-words mt-0.5">
                <TicketText
                  text={entry.body}
                  references={detail.references}
                  staffOptions={staffOptions}
                />
              </p>
            </li>
          ))}
        </ul>
      )}
      <TicketHistoryPagination detail={detail} kind="comments" />
      {detail.archivedAt ? (
        <p className="text-xs text-muted">
          Dieses Ticket ist archiviert. Die Unterhaltung bleibt lesbar.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim() && !pending) submit();
          }}
          className="space-y-2"
        >
          <MentionTextarea
            value={note}
            onChange={setNote}
            staffOptions={staffOptions}
            rows={3}
            maxLength={5000}
            ariaLabel="Kommentar"
            placeholder="Rückfrage oder Zwischenstand — mit @ Personen und mit #123 andere Tickets erwähnen."
            className="input text-sm w-full"
          />
          {error && (
            <p role="alert" className="alert-error-sm">
              {error}
            </p>
          )}
          <button type="submit" disabled={pending || !note.trim()} className="btn-primary text-xs">
            <Send className="h-3.5 w-3.5" />
            {pending ? 'Wird gesendet …' : 'Kommentieren'}
          </button>
        </form>
      )}
    </section>
  );
}
