'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Plus, Users } from 'lucide-react';
import { startInstanceAction } from './actions';

interface Template {
  id: string;
  name: string;
  _count: { steps: number };
}

interface StaffOption {
  id: string;
  fullName: string;
}

// Sentinel für „eigener Workflow (einmalig)" — kein Vorlagen-UUID.
const BLANK = '__blank__';

export function StartWorkflowForm({
  clientId,
  templates,
  staffOptions = [],
  analysisId,
}: {
  clientId: string;
  templates: Template[];
  staffOptions?: StaffOption[];
  analysisId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isBlank = choice === BLANK;

  function toggleMember(id: string) {
    setMemberIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    setError(null);
    if (!choice) {
      setError('„Eigener Workflow" oder eine Vorlage wählen.');
      return;
    }
    if (isBlank && !name.trim()) {
      setError('Bitte einen Namen für den Workflow angeben.');
      return;
    }
    start(async () => {
      const r = await startInstanceAction({
        clientId,
        memberIds: Array.from(memberIds),
        ...(analysisId ? { analysisId } : {}),
        ...(isBlank ? { name: name.trim() } : { templateId: choice }),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setOpen(false);
      setChoice('');
      setName('');
      setMemberIds(new Set());
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn-primary"
        aria-expanded={open}
        aria-controls={`start-workflow-${clientId}-panel`}
      >
        <Plus className="h-4 w-4" />
        Workflow starten
      </button>
      {open && (
        <div
          id={`start-workflow-${clientId}-panel`}
          className="absolute right-0 mt-2 w-96 z-20 rounded-lg shadow-lg border border-default bg-surface p-4 space-y-3"
        >
          <div>
            <label className="label" htmlFor={`start-workflow-${clientId}-choice`}>
              Workflow
            </label>
            <select
              id={`start-workflow-${clientId}-choice`}
              value={choice}
              onChange={(e) => {
                setChoice(e.target.value);
                setError(null);
              }}
              className="input"
            >
              <option value="">— wählen —</option>
              <option value={BLANK}>Eigener Workflow (einmalig) …</option>
              {templates.length > 0 && (
                <optgroup label="Aus Vorlage">
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t._count.steps} Schritte)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {templates.length === 0 && (
              <p className="text-xs text-muted mt-1">
                Keine Vorlagen vorhanden — als <strong>eigener Workflow</strong> starten und die
                Schritte danach hinzufügen.{' '}
                <Link href="/staff/workflows/templates" className="text-brand hover:underline">
                  Vorlagen anlegen →
                </Link>
              </p>
            )}
          </div>

          {isBlank && (
            <div>
              <label className="label" htmlFor={`start-workflow-${clientId}-name`}>
                Name des Workflows
              </label>
              <input
                id={`start-workflow-${clientId}-name`}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                placeholder="z. B. Klärung Kassenführung"
                className="input"
                autoFocus
                aria-describedby={`start-workflow-${clientId}-name-hint`}
              />
              <p id={`start-workflow-${clientId}-name-hint`} className="text-xs text-muted mt-1">
                Leerer Workflow — Schritte fügst du anschließend hinzu.
              </p>
            </div>
          )}

          {staffOptions.length > 0 && (
            <fieldset>
              <legend className="label inline-flex items-center gap-1">
                <Users className="h-3 w-3 text-disabled" />
                Team{' '}
                <span className="text-disabled font-normal">(optional, ich bin immer dabei)</span>
              </legend>
              <ul className="space-y-0.5 max-h-40 overflow-y-auto border border-default rounded p-1">
                {staffOptions.map((s) => (
                  <li key={s.id}>
                    <label className="flex items-center gap-2 px-2 py-1 text-sm hover:bg-gray-50 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={memberIds.has(s.id)}
                        onChange={() => toggleMember(s.id)}
                      />
                      <span>{s.fullName}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}

          {error && (
            <p className="text-xs text-red-700" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-muted hover:underline"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="btn-primary text-xs"
            >
              {isPending ? 'Startet…' : 'Starten'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
