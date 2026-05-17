'use client';

import { useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, X } from 'lucide-react';
import { handoverItemAction } from './actions';

interface StaffOption { id: string; fullName: string; }

/**
 * „Übergabe" — Schritt-Bearbeiter wechseln + automatischer Kommentar.
 * Anders als das einfache Assignee-Dropdown verlangt das einen kurzen
 * Übergabe-Hinweis und legt einen Kommentar an, damit nachvollziehbar
 * bleibt, was an wen weitergegeben wurde.
 */
export function HandoverButton({
  itemId,
  currentAssigneeStaffId,
  itemTitle,
  staffOptions,
}: {
  itemId: string;
  currentAssigneeStaffId: string | null;
  itemTitle: string;
  staffOptions: StaffOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [toStaffId, setToStaffId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const candidates = staffOptions.filter((s) => s.id !== currentAssigneeStaffId);

  function submit() {
    setError(null);
    if (!toStaffId) { setError('Bitte Empfänger wählen.'); return; }
    start(async () => {
      const r = await handoverItemAction({ itemId, toStaffId, note: note.trim() });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setOpen(false); setNote(''); setToStaffId('');
      router.refresh();
    });
  }

  const modal = open ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
      <div className="card w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <ArrowRightLeft className="h-4 w-4 text-brand-600" />
            Schritt übergeben
          </h2>
          <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          <strong>{itemTitle}</strong> — der bisherige Bearbeiter wird ersetzt und es wird
          automatisch ein Kommentar mit Datum und Empfänger angelegt.
        </p>
        <div>
          <label className="label">An wen</label>
          <select
            value={toStaffId}
            onChange={(e) => setToStaffId(e.target.value)}
            className="input text-sm"
          >
            <option value="">— Empfänger wählen —</option>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>{s.fullName}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Übergabe-Hinweis (optional)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder='z. B. „Beleg-Check fertig, bitte mit Vorgesetztem freigeben"'
            className="input text-sm"
          />
        </div>
        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300 p-2">{error}</div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary text-sm">Abbrechen</button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending || !toStaffId}
            className="btn-primary text-sm inline-flex items-center gap-1.5"
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
            {isPending ? 'Übergibt…' : 'Übergeben'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-gray-400 hover:text-brand-700 dark:hover:text-brand-300 p-1"
        title="Schritt an Kollegen übergeben"
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
