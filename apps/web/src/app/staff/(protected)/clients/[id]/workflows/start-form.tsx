'use client';

import { useState, useTransition } from 'react';
import { Plus, Users } from 'lucide-react';
import { startInstanceAction } from './actions';

interface Template {
  id: string;
  name: string;
  _count: { steps: number };
}

interface StaffOption { id: string; fullName: string; }

export function StartWorkflowForm({
  clientId,
  templates,
  staffOptions = [],
}: {
  clientId: string;
  templates: Template[];
  staffOptions?: StaffOption[];
}) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
    if (!templateId) { setError('Vorlage wählen.'); return; }
    start(async () => {
      const r = await startInstanceAction({
        clientId,
        templateId,
        memberIds: Array.from(memberIds),
      });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setOpen(false); setTemplateId(''); setMemberIds(new Set());
    });
  }

  if (templates.length === 0) {
    return (
      <a href="/staff/workflows/templates" className="btn-secondary text-xs">
        Vorlagen anlegen →
      </a>
    );
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="btn-primary">
        <Plus className="h-4 w-4" />
        Workflow starten
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-96 z-20 rounded-lg shadow-lg border border-default bg-surface p-4 space-y-3">
          <div>
            <label className="label">Vorlage</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="input"
            >
              <option value="">— Vorlage wählen —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t._count.steps} Schritte)
                </option>
              ))}
            </select>
          </div>

          {staffOptions.length > 0 && (
            <div>
              <label className="label inline-flex items-center gap-1">
                <Users className="h-3 w-3 text-disabled" />
                Team <span className="text-disabled font-normal">(optional, ich bin immer dabei)</span>
              </label>
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
            </div>
          )}

          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:underline">
              Abbrechen
            </button>
            <button type="button" onClick={submit} disabled={isPending} className="btn-primary text-xs">
              {isPending ? 'Startet…' : 'Starten'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
