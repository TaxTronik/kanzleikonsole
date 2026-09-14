'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Save, X, FileText, Pencil } from 'lucide-react';
import { saveRequestTemplateAction, deleteRequestTemplateAction } from './actions';
import { confirmDialog } from '@/components/ui/modal';

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

  async function remove(id: string) {
    if (
      !(await confirmDialog('Vorlage wirklich löschen?', {
        title: 'Anforderungsvorlage löschen',
        confirmLabel: 'Löschen',
        danger: true,
      }))
    )
      return;
    start(async () => {
      const r = await deleteRequestTemplateAction({ id });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="min-w-0 space-y-4">
      {initial.length === 0 ? (
        <div className="card p-6 text-center text-sm text-muted">
          Noch keine Vorlagen definiert.
        </div>
      ) : (
        <ul className="space-y-2">
          {initial.map((t) => (
            <li key={t.id} className="card p-4">
              <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
                <div className="min-w-0 w-full flex-1 [overflow-wrap:anywhere]">
                  <div className="flex min-w-0 items-center gap-2 flex-wrap [&>*]:max-w-full">
                    <span className="font-medium text-primary">{t.name}</span>
                    {t.category && <span className="badge-gray">{t.category}</span>}
                    <span className="badge-gray text-xs">{PRIORITY_LABELS[t.priority]}</span>
                    {t.dueAfterDays !== null && (
                      <span className="text-xs text-muted">fällig +{t.dueAfterDays} Tage</span>
                    )}
                    {t.formTemplateName && (
                      <span className="inline-flex min-w-0 items-start gap-1 text-xs text-brand-700">
                        <FileText className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="min-w-0">{t.formTemplateName}</span>
                      </span>
                    )}
                    {!t.active && <span className="badge-yellow">deaktiviert</span>}
                  </div>
                  <p className="text-xs text-muted mt-1 truncate">{t.title}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setEditing(t);
                    }}
                    className="btn-secondary text-xs py-1"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    className="icon-action hover:!text-red-700"
                    title="Löschen"
                    aria-label={`Anforderungsvorlage „${t.name}“ löschen`}
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
          onClick={() => {
            setError(null);
            setEditing(emptyDraft());
          }}
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

      {error && (
        <div className="alert-error-sm" role="alert">
          {error}
        </div>
      )}
      {isPending && (
        <p className="text-xs text-muted" role="status">
          Verarbeite…
        </p>
      )}
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

  const set = <K extends keyof Template>(k: K, v: Template[K]) => setT((s) => ({ ...s, [k]: v }));

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
    <div className="card min-w-0 space-y-4 p-4 sm:p-6">
      <h2 className="text-base font-semibold text-primary [overflow-wrap:anywhere]">
        {isNew ? 'Neue Vorlage' : `Bearbeiten: ${draft.name}`}
      </h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <div>
          <label className="label" htmlFor="request-template-name">
            Vorlagen-Name (intern)
          </label>
          <input
            id="request-template-name"
            type="text"
            value={t.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={120}
            placeholder="z. B. FiBu-Belege quartalsweise"
            className="input min-w-0"
          />
        </div>
        <div>
          <label className="label" htmlFor="request-template-category">
            Kategorie (optional)
          </label>
          <input
            id="request-template-category"
            type="text"
            value={t.category ?? ''}
            onChange={(e) => set('category', e.target.value)}
            maxLength={60}
            placeholder="z. B. FiBu, Lohn, Jahresabschluss"
            className="input min-w-0"
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="request-template-title">
          Titel der Anforderung (für den Mandant)
        </label>
        <input
          id="request-template-title"
          type="text"
          value={t.title}
          onChange={(e) => set('title', e.target.value)}
          maxLength={200}
          placeholder="z. B. Belege Quartal X"
          className="input min-w-0"
        />
      </div>

      <div>
        <label className="label" htmlFor="request-template-description">
          Beschreibung
        </label>
        <textarea
          id="request-template-description"
          value={t.description}
          onChange={(e) => set('description', e.target.value)}
          rows={5}
          maxLength={5000}
          placeholder="Was wird konkret benötigt? Markdown unterstützt."
          className="input min-w-0 text-sm"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 [&>*]:min-w-0">
        <div>
          <label className="label" htmlFor="request-template-priority">
            Priorität
          </label>
          <select
            id="request-template-priority"
            value={t.priority}
            onChange={(e) => set('priority', e.target.value as Priority)}
            className="input min-w-0"
          >
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="request-template-due-days">
            Fällig nach Tagen
          </label>
          <input
            id="request-template-due-days"
            type="number"
            min={0}
            max={365}
            value={t.dueAfterDays ?? ''}
            onChange={(e) =>
              set(
                'dueAfterDays',
                e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
              )
            }
            placeholder="leer = keine Fälligkeit"
            className="input min-w-0"
          />
        </div>
        <fieldset>
          <legend className="label">Status</legend>
          <label className="flex items-center gap-2 text-sm mt-2">
            <input
              type="checkbox"
              checked={t.active}
              onChange={(e) => set('active', e.target.checked)}
              className="rounded border-strong text-brand-600"
            />
            <span>Aktiv</span>
          </label>
        </fieldset>
      </div>

      <div>
        <label className="label" htmlFor="request-template-form">
          Verknüpftes Formular (optional)
        </label>
        <select
          id="request-template-form"
          value={t.formTemplateId ?? ''}
          onChange={(e) => set('formTemplateId', e.target.value || null)}
          className="input min-w-0"
          aria-describedby="request-template-form-hint"
        >
          <option value="">— kein Formular —</option>
          {formTemplates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <p id="request-template-form-hint" className="text-xs text-muted mt-1">
          Wenn gesetzt: beim Erstellen der Anforderung wird automatisch eine Formular-Submission
          angelegt und mitgeschickt.
        </p>
      </div>

      {error && (
        <div className="alert-error-sm" role="alert">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
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
