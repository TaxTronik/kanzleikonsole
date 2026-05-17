'use client';

import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { updateMachineMetaAction, deleteMachineAction } from '../actions';

export function MachineMetaForm({
  machineId,
  initial,
}: {
  machineId: string;
  initial: { name: string; description: string; appliesTo: string; active: boolean };
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [appliesTo, setAppliesTo] = useState(initial.appliesTo);
  const [active, setActive] = useState(initial.active);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const r = await updateMachineMetaAction({
        id: machineId,
        name: name.trim(),
        description: description.trim() || null,
        appliesTo: appliesTo.trim() || null,
        active,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  function remove() {
    if (!confirm('Status-Maschine wirklich löschen? Alle Zustände und Übergänge werden mit gelöscht.')) return;
    setError(null);
    start(async () => {
      const r = await deleteMachineAction({ id: machineId });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      router.push('/staff/admin/state-machines');
    });
  }

  return (
    <div className="card p-6 mb-6 space-y-3">
      <h2 className="text-sm font-medium text-gray-900">Stammdaten</h2>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className="input"
          />
        </div>
        <div>
          <label className="label">Geltungsbereich</label>
          <input
            type="text"
            value={appliesTo}
            onChange={(e) => setAppliesTo(e.target.value)}
            maxLength={60}
            className="input text-sm"
          />
        </div>
      </div>
      <div>
        <label className="label">Beschreibung</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={500}
          className="input text-sm"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="rounded border-gray-300 text-brand-600"
        />
        <span>Aktiv</span>
      </label>
      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          {isPending ? 'Speichert…' : 'Stammdaten speichern'}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={isPending}
          className="text-gray-400 hover:text-red-700 p-2 ml-auto"
          title="Status-Maschine löschen"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        {savedAt && (
          <span className="text-xs text-emerald-700">
            Gespeichert {new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium' }).format(new Date(savedAt))}
          </span>
        )}
      </div>
    </div>
  );
}
