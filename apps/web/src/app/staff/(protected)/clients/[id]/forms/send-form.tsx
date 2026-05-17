'use client';

import { useState, useTransition } from 'react';
import { Plus } from 'lucide-react';
import { createSubmissionAction } from '../../../forms/actions';

interface Template {
  id: string;
  name: string;
  _count: { fields: number };
}

export function SendFormButton({ clientId, templates }: { clientId: string; templates: Template[] }) {
  const [open, setOpen] = useState(false);
  const [tplId, setTplId] = useState('');
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (!tplId) {
      setError('Vorlage wählen.');
      return;
    }
    start(async () => {
      const r = await createSubmissionAction({ templateId: tplId, clientId });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setOpen(false);
      setTplId('');
    });
  }

  if (templates.length === 0) {
    return (
      <a href="/staff/forms" className="btn-secondary text-xs">
        Vorlagen anlegen →
      </a>
    );
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="btn-primary">
        <Plus className="h-4 w-4" /> Formular senden
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 z-20 rounded-lg shadow-lg border border-gray-200 bg-white p-4 space-y-3">
          <select value={tplId} onChange={(e) => setTplId(e.target.value)} className="input">
            <option value="">— Vorlage wählen —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t._count.fields} Felder)
              </option>
            ))}
          </select>
          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:underline">
              Abbrechen
            </button>
            <button type="button" onClick={submit} disabled={isPending} className="btn-primary text-xs">
              {isPending ? 'Sendet…' : 'Senden'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
