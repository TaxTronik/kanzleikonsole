'use client';

import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { confirmGwgDeletionAction, confirmGwgCheckDeletionAction } from './actions';
import { confirmDialog } from '@/components/ui/modal';

export function GwgDeleteButton({
  documentId,
  label,
  destructionPending = false,
}: {
  documentId: string;
  label: string;
  destructionPending?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirmDialog(
      `GwG-Beleg endgültig und unwiderruflich vernichten?\n\n${label}\n\n` +
        'Die Datei wird aus dem Object-Store gelöscht. Nur fortfahren, wenn die ' +
        'gesetzliche Aufbewahrungsfrist (§ 8 Abs. 4 GwG) abgelaufen ist.',
      { title: 'GwG-Beleg vernichten', confirmLabel: 'Endgültig vernichten', danger: true },
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
        {pending ? 'Vernichte…' : destructionPending ? 'Vernichtung fortsetzen' : 'Vernichten'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function GwgCheckDeleteButton({
  checkId,
  label,
  disabledReason,
}: {
  checkId: string;
  label: string;
  /** z. B. „erst Datei-Belege vernichten" — Button bleibt dann inaktiv. */
  disabledReason?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirmDialog(
      `GwG-Aufzeichnungen endgültig und unwiderruflich vernichten?\n\n${label}\n\n` +
        'Wirtschaftlich Berechtigte werden gelöscht, Ausweis-Details und ' +
        'Risikoangaben entfernt. Ein Skelett-Datensatz (Status, Vernichtungsvermerk) ' +
        'bleibt als Nachweis erhalten (§ 8 Abs. 4 GwG).',
      {
        title: 'GwG-Aufzeichnungen vernichten',
        confirmLabel: 'Endgültig vernichten',
        danger: true,
      },
    );
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await confirmGwgCheckDeletionAction({ checkId });
      if (!r.ok) setError(r.error ?? 'Fehler bei der Vernichtung.');
    });
  }

  if (disabledReason) {
    return <span className="text-xs text-muted">{disabledReason}</span>;
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
