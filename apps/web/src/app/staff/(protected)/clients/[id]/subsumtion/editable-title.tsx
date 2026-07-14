'use client';

import { useState, useTransition } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';
import { updateAnalysisAction } from './actions';

/** Inline editierbarer Subsumtions-Titel (Review-Modus). Klick aufs Stift-Icon
 *  → Eingabefeld; Enter/Speichern persistiert, Esc/Abbrechen verwirft. */
export function EditableAnalysisTitle({
  clientId,
  analysisId,
  initialTitle,
}: {
  clientId: string;
  analysisId: string;
  initialTitle: string | null;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialTitle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function open() {
    setDraft(title ?? '');
    setError(null);
    setEditing(true);
  }

  function save() {
    const next = draft.trim() || null;
    start(async () => {
      const r = await updateAnalysisAction({ clientId, analysisId, title: next });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTitle(r.title);
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            placeholder="Bezeichnung der Subsumtion …"
            maxLength={200}
            className="flex-1 min-w-0 rounded-md border border-default bg-surface px-3 py-1.5 text-xl font-bold text-primary"
          />
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="btn-primary text-sm shrink-0"
            title="Speichern"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={pending}
            className="btn-secondary text-sm shrink-0"
            title="Abbrechen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</p>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className="group flex items-center gap-2 min-w-0 text-left"
      title="Titel ändern"
    >
      <h1 className="text-2xl font-bold text-primary truncate">
        {title || <span className="text-muted font-normal italic">Ohne Titel</span>}
      </h1>
      <Pencil className="h-4 w-4 text-disabled opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}
