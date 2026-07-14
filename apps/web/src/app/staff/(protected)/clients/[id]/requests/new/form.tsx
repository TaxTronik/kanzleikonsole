'use client';

import { useActionState, useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { createRequestAction, type ActionResult } from '../actions';

type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

interface Template {
  id: string;
  name: string;
  category: string | null;
  title: string;
  description: string;
  priority: Priority;
  dueAfterDays: number | null;
  formTemplateId: string | null;
}

interface FormTpl {
  id: string;
  name: string;
}

interface Props {
  clientId: string;
  disabled?: boolean;
  templates: Template[];
  formTemplates: FormTpl[];
}

function isoLocalForDate(d: Date): string {
  // Liefert YYYY-MM-DDTHH:mm für <input type="datetime-local"> in lokaler TZ
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewRequestForm({ clientId, disabled, templates, formTemplates }: Props) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createRequestAction,
    null,
  );

  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [dueAt, setDueAt] = useState('');
  const [formTemplateId, setFormTemplateId] = useState('');

  function applyTemplate(id: string) {
    setSelectedTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setTitle(t.title);
    setDescription(t.description);
    setPriority(t.priority);
    if (t.dueAfterDays !== null) {
      const due = new Date();
      due.setDate(due.getDate() + t.dueAfterDays);
      setDueAt(isoLocalForDate(due));
    } else {
      setDueAt('');
    }
    setFormTemplateId(t.formTemplateId ?? '');
  }

  // Templates nach Kategorie gruppieren für ein sauberes optgroup-Dropdown
  const grouped = new Map<string, Template[]>();
  for (const t of templates) {
    const key = t.category?.trim() || 'Allgemein';
    const arr = grouped.get(key) ?? [];
    arr.push(t);
    grouped.set(key, arr);
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="clientId" value={clientId} />
      {selectedTemplateId && <input type="hidden" name="templateId" value={selectedTemplateId} />}
      <input type="hidden" name="formTemplateId" value={formTemplateId} />

      {templates.length > 0 && (
        <div className="rounded-md border border-brand-200 bg-brand-50/30 p-3">
          <label className="label flex items-center gap-1.5" htmlFor="template">
            <Sparkles className="h-3.5 w-3.5 text-brand-600" />
            Vorlage anwenden
          </label>
          <select
            id="template"
            value={selectedTemplateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="input"
            disabled={disabled}
          >
            <option value="">— keine Vorlage (manuell ausfüllen) —</option>
            {Array.from(grouped.entries()).map(([cat, list]) => (
              <optgroup key={cat} label={cat}>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.formTemplateId ? ' · mit Formular' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="label" htmlFor="title">
          Titel
        </label>
        <input
          id="title"
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input"
          placeholder="z. B. Belege Q3 2025"
          required
          minLength={2}
          maxLength={200}
          disabled={disabled}
        />
        {state?.fieldErrors?.['title'] && (
          <p className="text-xs text-red-600 mt-1">{state.fieldErrors['title']}</p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="description">
          Beschreibung
        </label>
        <textarea
          id="description"
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          className="input"
          placeholder="Was wird vom Mandanten benötigt?"
          required
          minLength={2}
          maxLength={5000}
          disabled={disabled}
        />
        {state?.fieldErrors?.['description'] && (
          <p className="text-xs text-red-600 mt-1">{state.fieldErrors['description']}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="priority">
            Priorität
          </label>
          <select
            id="priority"
            name="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            className="input"
            disabled={disabled}
          >
            <option value="LOW">Niedrig</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">Hoch</option>
            <option value="URGENT">Dringend</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="dueAt">
            Fällig am
          </label>
          <input
            id="dueAt"
            name="dueAt"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="input"
            disabled={disabled}
          />
        </div>
      </div>

      <div>
        <label className="label">Formular mitschicken (optional)</label>
        <select
          value={formTemplateId}
          onChange={(e) => setFormTemplateId(e.target.value)}
          className="input"
          disabled={disabled}
        >
          <option value="">— kein Formular —</option>
          {formTemplates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {formTemplateId && (
          <p className="text-xs text-brand-700 mt-1 flex items-center gap-1">
            <FileText className="h-3 w-3" />
            Der Mandant bekommt das Formular in seinem Portal angezeigt.
          </p>
        )}
      </div>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}

      <button type="submit" className="btn-primary" disabled={isPending || disabled}>
        {isPending ? 'Wird gespeichert…' : 'Anforderung erstellen'}
      </button>
    </form>
  );
}
