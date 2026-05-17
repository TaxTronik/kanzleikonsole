'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Save, X, FileText, Pencil } from 'lucide-react';
import {
  saveRequestTemplateAction,
  deleteRequestTemplateAction,
} from './actions';

type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Niedrig',
  NORMAL: 'Normal',
  HIGH: 'Hoch',
  URGENT: 'Dringend',
};

interface Template {
  id: string;
  name: string;
  category: string | null;
  title: string;
  description: string;
  priority: Priority;
  dueAfterDays: number | null;
  formTemplateId: string | null;
  formTemplateName: string | null;
  active: boolean;
}

interface FormTpl {
  id: string;
  name: string;
}

function emptyDraft(): Template {
  return {
    id: '',
    name: '',
    category: '',
    title: '',
    description: '',
    priority: 'NORMAL',
    dueAfterDays: null,
    formTemplateId: null,
    formTemplateName: null,
    active: true,
  };
}

export function RequestTemplateEditor({
  initial,
  formTemplates,
}: {
  initial: Template[];
  formTemplates: FormTpl[];
}) {
  const [editing, setEditing] = useState<Template | null>(null);
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove(id: string) {
    if (!confirm('Vorlage wirklich löschen?')) return;
    start(async () => {
      const r = await deleteRequestTemplateAction({ id });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="space-y-4">
      {initial.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gray-500">
          Noch keine Vorlagen definiert.
        </div>
      ) : (
        <ul className="space-y-2">
          {initial.map((t) => (
            <li key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900">{t.name}</span>
                    {t.category && <span className="badge-gray">{t.category}</span>}
                    <span className="badge-gray text-xs">{PRIORITY_LABELS[t.priority]}</span>
                    {t.dueAfterDays !== null && (
                      <span className="text-xs text-gray-500">fällig +{t.dueAfterDays} Tage</span>
                    )}
                    {t.formTemplateName && (
                      <span className="inline-flex items-center gap-1 text-xs text-brand-700">
                        <FileText className="h-3 w-3" />
                        {t.formTemplateName}
                      </span>
                    )}
                    {!t.active && <span className="badge-yellow">deaktiviert</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 truncate">{t.title}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setError(null); setEditing(t); }}
                    className="btn-secondary text-xs py-1"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    className="text-gray-400 hover:text-red-700 p-1"
                    title="Löschen"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!editing && (
        <button
          type="button"
          onClick={() => { setError(null); setEditing(emptyDraft()); }}
          className="btn-primary"
        >
          <Plus className="h-4 w-4" />
          Neue Vorlage
        </button>
      )}

      {editing && (
        <Form
          draft={editing}
          formTemplates={formTemplates}
          onCancel={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {isPending && <p className="text-xs text-gray-500">Verarbeite…</p>}
    </div>
  );
}

function Form({
  draft,
  formTemplates,
  onCancel,
  onSaved,
}: {
  draft: Template;
  formTemplates: FormTpl[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [t, setT] = useState<Template>(draft);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const isNew = !t.id;

  const set = <K extends keyof Template>(k: K, v: Template[K]) =>
    setT((s) => ({ ...s, [k]: v }));

  function save() {
    setError(null);
    if (!t.name.trim() || !t.title.trim() || !t.description.trim()) {
      setError('Name, Titel und Beschreibung sind Pflicht.');
      return;
    }
    start(async () => {
      const r = await saveRequestTemplateAction({
        id: t.id || null,
        name: t.name.trim(),
        category: t.category?.trim() || null,
        title: t.title.trim(),
        description: t.description.trim(),
        priority: t.priority,
        dueAfterDays: t.dueAfterDays,
        formTemplateId: t.formTemplateId,
        active: t.active,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      onSaved();
      window.location.reload();
    });
  }

  return (
    <div className="card p-6 space-y-4 border-brand-300">
      <h2 className="text-sm font-medium text-gray-900">
        {isNew ? 'Neue Vorlage' : `Bearbeiten: ${draft.name}`}
      </h2>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Vorlagen-Name (intern)</label>
          <input
            type="text"
            value={t.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={120}
            placeholder="z. B. FiBu-Belege quartalsweise"
            className="input"
          />
        </div>
        <div>
          <label className="label">Kategorie (optional)</label>
          <input
            type="text"
            value={t.category ?? ''}
            onChange={(e) => set('category', e.target.value)}
            maxLength={60}
            placeholder="z. B. FiBu, Lohn, Jahresabschluss"
            className="input"
          />
        </div>
      </div>

      <div>
        <label className="label">Titel der Anforderung (für den Mandant)</label>
        <input
          type="text"
          value={t.title}
          onChange={(e) => set('title', e.target.value)}
          maxLength={200}
          placeholder="z. B. Belege Quartal X"
          className="input"
        />
      </div>

      <div>
        <label className="label">Beschreibung</label>
        <textarea
          value={t.description}
          onChange={(e) => set('description', e.target.value)}
          rows={5}
          maxLength={5000}
          placeholder="Was wird konkret benötigt? Markdown unterstützt."
          className="input text-sm"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Priorität</label>
          <select
            value={t.priority}
            onChange={(e) => set('priority', e.target.value as Priority)}
            className="input"
          >
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
              <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Fällig nach Tagen</label>
          <input
            type="number"
            min={0}
            max={365}
            value={t.dueAfterDays ?? ''}
            onChange={(e) => set('dueAfterDays', e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
            placeholder="leer = keine Fälligkeit"
            className="input"
          />
        </div>
        <div>
          <label className="label">Status</label>
          <label className="flex items-center gap-2 text-sm mt-2">
            <input
              type="checkbox"
              checked={t.active}
              onChange={(e) => set('active', e.target.checked)}
              className="rounded border-gray-300 text-brand-600"
            />
            <span>Aktiv</span>
          </label>
        </div>
      </div>

      <div>
        <label className="label">Verknüpftes Formular (optional)</label>
        <select
          value={t.formTemplateId ?? ''}
          onChange={(e) => set('formTemplateId', e.target.value || null)}
          className="input"
        >
          <option value="">— kein Formular —</option>
          {formTemplates.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Wenn gesetzt: beim Erstellen der Anforderung wird automatisch eine
          Formular-Submission angelegt und mitgeschickt.
        </p>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          <Save className="h-4 w-4" />
          {isPending ? 'Speichert…' : 'Speichern'}
        </button>
        <button type="button" onClick={onCancel} disabled={isPending} className="btn-secondary">
          <X className="h-4 w-4" />
          Abbrechen
        </button>
      </div>
    </div>
  );
}
