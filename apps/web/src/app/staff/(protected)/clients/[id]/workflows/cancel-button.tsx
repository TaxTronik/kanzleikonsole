'use client';

import { useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Ban, X } from 'lucide-react';
import { cancelInstanceAction } from './actions';

interface Props {
  instanceId: string;
  instanceName: string;
  variant?: 'compact' | 'full';
}

export function CancelWorkflowButton({ instanceId, instanceName, variant = 'compact' }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function submit() {
    setError(null);
    if (reason.trim().length < 3) { setError('Grund (mind. 3 Zeichen) angeben.'); return; }
    start(async () => {
      const r = await cancelInstanceAction({ instanceId, reason: reason.trim() });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setOpen(false);
      setReason('');
      router.refresh();
    });
  }

  const modal = open ? (
    <div
      className="modal-overlay"
      onClick={() => setOpen(false)}
    >
      <div
        className="card w-full max-w-md p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-primary inline-flex items-center gap-1.5">
            <Ban className="h-4 w-4 text-red-600" />
            Workflow abbrechen
          </h2>
          <button type="button" onClick={() => setOpen(false)} className="text-disabled hover:text-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-secondary">
          Sind Sie sicher, dass Sie <strong>{instanceName}</strong> abbrechen wollen? Bereits
          erledigte Schritte bleiben in der Historie. Offene Schritte werden nicht mehr
          ausgeführt. Der Vorgang ist nicht rückgängig zu machen.
        </p>
        <div>
          <label className="label">Grund (wird im Audit-Log gespeichert)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder='z. B. „Mandat verloren", „Doppelt angelegt", „Falsche Vorlage"'
            className="input text-sm"
          />
        </div>
        {error && (
          <div className="alert-error-sm text-xs p-2">
            {error}
          </div>
        )}
        <div className="form-actions">
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary text-sm">
            Behalten
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending || reason.trim().length < 3}
            className="text-sm font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            <Ban className="h-3.5 w-3.5" />
            {isPending ? 'Bricht ab…' : 'Workflow abbrechen'}
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
        className={
          variant === 'full'
            ? 'btn-secondary text-xs inline-flex items-center gap-1 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
            : 'text-xs text-disabled hover:text-red-700 dark:hover:text-red-400 inline-flex items-center gap-1'
        }
        title="Workflow abbrechen"
      >
        <Ban className="h-3 w-3" />
        {variant === 'full' ? 'Abbrechen' : ''}
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
