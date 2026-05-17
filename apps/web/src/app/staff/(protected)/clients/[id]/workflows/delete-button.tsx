'use client';

import { useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Trash2, X, AlertTriangle } from 'lucide-react';
import { deleteCancelledInstanceAction } from './actions';

interface Props {
  instanceId: string;
  instanceName: string;
}

/**
 * Stufe 2 der zweistufigen Löschung: aus dem „Papierkorb" (abgebrochene
 * Workflows) wirklich entfernen. Erfordert Eingabe des Workflow-Namens als
 * Bestätigung — damit nicht mit einem Fehlklick die Historie weg ist.
 */
export function DeleteWorkflowButton({ instanceId, instanceName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const ready = confirmation.trim() === instanceName.trim();

  function submit() {
    setError(null);
    if (!ready) { setError('Bitte den Workflow-Namen zur Bestätigung eingeben.'); return; }
    start(async () => {
      const r = await deleteCancelledInstanceAction({ instanceId });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setOpen(false);
      setConfirmation('');
      router.refresh();
    });
  }

  const modal = open ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="card w-full max-w-md p-5 space-y-3 border-2 border-red-300 dark:border-red-900/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-red-700 dark:text-red-400 inline-flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            Endgültig löschen
          </h2>
          <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-gray-700 dark:text-gray-300">
          Diese Aktion entfernt <strong>{instanceName}</strong> samt allen Schritten und Notizen
          unwiderruflich. Der Audit-Trail bleibt erhalten, aber die Items selbst sind weg.
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Geben Sie zur Bestätigung den Workflow-Namen exakt ein:
        </p>
        <input
          type="text"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={instanceName}
          className="input text-sm"
          autoFocus
        />
        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300 p-2">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary text-sm">
            Behalten
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending || !ready}
            className="text-sm font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {isPending ? 'Lösche…' : 'Endgültig löschen'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        className="text-xs text-gray-400 hover:text-red-700 dark:hover:text-red-400 inline-flex items-center gap-1"
        title="Endgültig löschen"
      >
        <Trash2 className="h-3 w-3" />
        Löschen
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
