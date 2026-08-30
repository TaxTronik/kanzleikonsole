'use client';

import { useState, useTransition } from 'react';
import { setTemplateActiveAction, deleteTemplateAction } from '../actions';
import { confirmDialog } from '@/components/ui/modal';

export function ToggleActiveForm({ id, active }: { id: string; active: boolean }) {
  const [isPending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        start(async () => {
          await setTemplateActiveAction({ id, active: !active });
        });
      }}
      className={
        active ? 'text-xs text-red-700 hover:underline' : 'text-xs text-emerald-700 hover:underline'
      }
    >
      {active ? 'Deaktivieren' : 'Aktivieren'}
    </button>
  );
}

export function DeleteTemplateForm({
  id,
  name,
  instances,
}: {
  id: string;
  name: string;
  instances: number;
}) {
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    if (instances > 0) {
      setError(
        `${instances} Instanz${instances === 1 ? '' : 'en'} vorhanden — bitte deaktivieren.`,
      );
      return;
    }
    if (
      !(await confirmDialog(
        `Vorlage „${name}" wirklich löschen? Alle Schritte werden mit gelöscht.`,
        {
          title: 'Workflow-Vorlage löschen',
          confirmLabel: 'Löschen',
          danger: true,
        },
      ))
    )
      return;
    start(async () => {
      const r = await deleteTemplateAction({ id });
      if (!r.ok) setError(r.error ?? 'Fehler beim Löschen.');
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending || instances > 0}
        className="text-xs text-red-700 hover:underline disabled:opacity-40"
        title={
          instances > 0 ? 'Mit Instanzen nicht löschbar — bitte deaktivieren' : 'Vorlage löschen'
        }
      >
        {isPending ? '…' : 'Löschen'}
      </button>
      {error && <span className="text-[10px] text-red-700">{error}</span>}
    </span>
  );
}
