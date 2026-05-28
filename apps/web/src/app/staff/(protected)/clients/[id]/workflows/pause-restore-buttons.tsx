'use client';

import { useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Pause, Play, RotateCcw, X } from 'lucide-react';
import { pauseInstanceAction, resumeInstanceAction, restoreInstanceAction } from './actions';

// ----------------------------------------------------------------------------
// Pause-Button (für ACTIVE) — Modal mit Grund + optionalem Wiederaufnahme-Datum
// ----------------------------------------------------------------------------

export function PauseWorkflowButton({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function submit() {
    setError(null);
    start(async () => {
      const r = await pauseInstanceAction({
        instanceId,
        reason: reason.trim(),
        until: until || null,
      });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setOpen(false);
      setReason('');
      setUntil('');
      router.refresh();
    });
  }

  const modal = open ? (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="card w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-primary inline-flex items-center gap-1.5">
            <Pause className="h-4 w-4 text-amber-600" />
            Workflow pausieren
          </h2>
          <button type="button" onClick={() => setOpen(false)} className="text-disabled hover:text-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-secondary">
          <strong>{instanceName}</strong> wird angehalten. Offene Schritte bleiben sichtbar,
          werden aber nicht mehr in den „Mein Tag"-Listen geführt.
        </p>
        <div>
          <label className="label">Wiederaufnahme am (optional)</label>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="input text-sm"
          />
          <p className="text-[10px] text-muted mt-1">
            Wenn gesetzt, wird der Workflow ab diesem Tag automatisch wieder aktiv.
            Leer = unbefristet pausiert, muss manuell fortgesetzt werden.
          </p>
        </div>
        <div>
          <label className="label">Grund (optional)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder='z. B. „Mandant im Urlaub", „warten auf Unterlagen"'
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
            Abbrechen
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="text-sm font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
          >
            <Pause className="h-3.5 w-3.5" />
            {isPending ? 'Pausiere…' : 'Pausieren'}
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
        className="btn-secondary text-xs inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
        title="Workflow pausieren"
      >
        <Pause className="h-3 w-3" />
        Pausieren
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}

// ----------------------------------------------------------------------------
// Resume-Button (für PAUSED) — kein Modal nötig
// ----------------------------------------------------------------------------

export function ResumeWorkflowButton({ instanceId }: { instanceId: string }) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  function go() {
    start(async () => {
      const r = await resumeInstanceAction({ instanceId });
      if (r.ok) router.refresh();
      else alert(r.error ?? 'Fehler.');
    });
  }
  return (
    <button
      type="button"
      onClick={go}
      disabled={isPending}
      className="btn-secondary text-xs inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
      title="Workflow fortsetzen"
    >
      <Play className="h-3 w-3" />
      {isPending ? 'Setze fort…' : 'Fortsetzen'}
    </button>
  );
}

// ----------------------------------------------------------------------------
// Restore-Button (für CANCELLED im Archiv) — Wiederherstellen aus Papierkorb
// ----------------------------------------------------------------------------

export function RestoreWorkflowButton({ instanceId }: { instanceId: string }) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  function go(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Workflow wiederherstellen? Status geht zurück auf "Aktiv".')) return;
    start(async () => {
      const r = await restoreInstanceAction({ instanceId });
      if (r.ok) router.refresh();
      else alert(r.error ?? 'Fehler.');
    });
  }
  return (
    <button
      type="button"
      onClick={go}
      disabled={isPending}
      className="text-xs text-muted hover:text-emerald-700 dark:hover:text-emerald-400 inline-flex items-center gap-1"
      title="Aus Papierkorb wiederherstellen"
    >
      <RotateCcw className="h-3 w-3" />
      {isPending ? 'Stelle her…' : 'Wiederherstellen'}
    </button>
  );
}
