'use client';

import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { confirmGwgDeletionAction } from './actions';

export function GwgDeleteButton({ documentId, label }: { documentId: string; label: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    const ok = window.confirm(
      `GwG-Beleg endgültig und unwiderruflich vernichten?\n\n${label}\n\n` +
        'Die Datei wird aus dem Object-Store gelöscht. Nur fortfahren, wenn die ' +
        'gesetzliche Aufbewahrungsfrist (§ 8 Abs. 4 GwG) abgelaufen ist.',
    );
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await confirmGwgDeletionAction({ documentId });
      if (!r.ok) setError(r.error ?? 'Fehler bei der Vernichtung.');
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {pending ? 'Vernichte…' : 'Vernichten'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
