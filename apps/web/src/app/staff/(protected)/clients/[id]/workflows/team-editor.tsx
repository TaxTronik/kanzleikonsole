'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Users, X } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { setWorkflowMembersAction } from './actions';

interface StaffOption {
  id: string;
  fullName: string;
}

/**
 * Team-Editor pro Workflow-Instanz. Multi-Select aus aktiven Mitarbeitern.
 * Der Starter ist immer Mitglied — kann nicht entfernt werden.
 */
export function TeamEditorButton({
  instanceId,
  startedByStaff,
  currentMemberIds,
  staffOptions,
}: {
  instanceId: string;
  startedByStaff: string;
  currentMemberIds: string[];
  staffOptions: StaffOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(currentMemberIds));
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function openEditor() {
    // Jeder neue Entwurf beginnt mit dem aktuellen Serverstand. Weitere
    // Renders während der Bearbeitung überschreiben die Auswahl nicht.
    setSelected(new Set(currentMemberIds));
    setError(null);
    setOpen(true);
  }

  function toggle(id: string) {
    if (id === startedByStaff) return; // Starter kann nicht entfernt werden
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setError(null);
    start(async () => {
      const r = await setWorkflowMembersAction({
        instanceId,
        memberIds: Array.from(selected),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  const modal = open ? (
    <Modal
      title="Team bearbeiten"
      onClose={() => setOpen(false)}
      panelClassName="card w-full max-w-md p-5 space-y-3"
      showCloseButton={false}
      closeDisabled={isPending}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-primary inline-flex items-center gap-1.5">
          <Users className="h-4 w-4 text-brand-600" />
          Team bearbeiten
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-disabled hover:text-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-secondary">
        Wählen Sie die Mitarbeiter, die am Workflow beteiligt sind. Die Übergabe einzelner Schritte
        bleibt davon unberührt. Der Starter ist immer Mitglied.
      </p>
      <ul className="space-y-1 max-h-64 overflow-y-auto border border-default rounded-md p-2">
        {staffOptions.map((s) => {
          const checked = selected.has(s.id);
          const isStarter = s.id === startedByStaff;
          return (
            <li key={s.id}>
              <label
                className={
                  isStarter
                    ? 'flex items-center gap-2 px-2 py-1.5 rounded text-sm text-muted cursor-not-allowed'
                    : 'flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer hover:bg-gray-50'
                }
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(s.id)}
                  disabled={isStarter}
                />
                <span className="flex-1">{s.fullName}</span>
                {isStarter && (
                  <span className="text-[10px] uppercase text-disabled bg-gray-100 rounded px-1.5 py-0.5">
                    Starter
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      {error && <div className="alert-error-sm text-xs p-2">{error}</div>}
      <div className="form-actions">
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary text-sm">
          Abbrechen
        </button>
        <button type="button" onClick={save} disabled={isPending} className="btn-primary text-sm">
          {isPending
            ? 'Speichere…'
            : `${selected.size} Mitglied${selected.size === 1 ? '' : 'er'} speichern`}
        </button>
      </div>
    </Modal>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        className="text-xs text-muted hover:text-brand-700 dark:hover:text-brand-300 inline-flex items-center gap-1"
        title="Team bearbeiten"
      >
        <Users className="h-3 w-3" />
        Team
      </button>
      {modal}
    </>
  );
}
