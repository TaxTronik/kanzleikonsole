'use client';

import { useState, useTransition } from 'react';
import {
  setFormActiveAction,
  deleteFormTemplateAction,
} from './actions';

export function FormRowActions({
  id,
  name,
  active,
  submissions,
}: {
  id: string;
  name: string;
  active: boolean;
  submissions: number;
}) {
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    start(async () => {
      await setFormActiveAction({ id, active: !active });
    });
  }
  function remove() {
    setError(null);
    if (submissions > 0) {
      setError(`${submissions} Anfrage${submissions === 1 ? '' : 'n'} vorhanden — bitte deaktivieren.`);
      return;
    }
    if (!confirm(`Vorlage „${name}" wirklich löschen? Alle Felder werden mit gelöscht.`)) return;
    start(async () => {
      const r = await deleteFormTemplateAction({ id });
      if (!r.ok) setError(r.error ?? 'Fehler beim Löschen.');
    });
  }

  return (
    <div className="flex items-center justify-end gap-3">
      <a href={`/staff/forms/${id}`} className="text-xs text-brand-700 hover:underline">
        Bearbeiten
      </a>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        className={
          active
            ? 'text-xs text-red-700 hover:underline'
            : 'text-xs text-emerald-700 hover:underline'
        }
      >
        {active ? 'Deaktivieren' : 'Aktivieren'}
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={isPending || submissions > 0}
        className="text-xs text-red-700 hover:underline disabled:opacity-40"
        title={submissions > 0 ? 'Mit Anfragen nicht löschbar' : 'Vorlage löschen'}
      >
        Löschen
      </button>
      {error && <span className="text-[10px] text-red-700">{error}</span>}
    </div>
  );
}
