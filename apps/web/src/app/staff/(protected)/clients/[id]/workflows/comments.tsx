'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Send } from 'lucide-react';
import { addItemCommentAction } from './actions';

interface Comment {
  id: string;
  authorName: string;
  body: string;
  createdAt: string; // ISO
}

const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export function WorkflowItemComments({
  itemId,
  initial,
}: {
  itemId: string;
  initial: Comment[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initial.length > 0);
  const [body, setBody] = useState('');
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (!body.trim()) return;
    start(async () => {
      const r = await addItemCommentAction({ itemId, body: body.trim() });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setBody('');
      router.refresh();
    });
  }

  return (
    <div className="mt-2">
      {!open && initial.length === 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[11px] text-disabled hover:text-brand-700 dark:hover:text-brand-300 inline-flex items-center gap-1"
        >
          <MessageSquare className="h-3 w-3" />
          Kommentar hinzufügen
        </button>
      )}
      {(open || initial.length > 0) && (
        <div className="space-y-2">
          {initial.length > 0 && (
            <ul className="space-y-1.5 text-xs border-l-2 border-default pl-3">
              {initial.map((c) => (
                <li key={c.id}>
                  <div className="text-primary whitespace-pre-wrap">{c.body}</div>
                  <div className="text-[10px] text-disabled mt-0.5">
                    {c.authorName} · {dateTimeFmt.format(new Date(c.createdAt))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-start gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Kommentar…"
              rows={1}
              maxLength={5000}
              className="input text-xs flex-1"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
              }}
            />
            <button
              type="button"
              onClick={submit}
              disabled={isPending || !body.trim()}
              className="btn-secondary text-xs inline-flex items-center gap-1 shrink-0"
              title="Kommentar speichern (âŒ˜+Enter)"
            >
              <Send className="h-3 w-3" />
              {isPending ? 'Lädt…' : 'Senden'}
            </button>
          </div>
          {error && <p className="text-[11px] text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
