'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Save, X, Mail, Pencil, Lock } from 'lucide-react';
import { saveEmailTemplateAction, deleteEmailTemplateAction } from './actions';

interface Template {
  id: string;
  slug: string | null;
  name: string;
  category: string | null;
  subject: string;
  bodyMd: string;
  active: boolean;
}

function emptyDraft(): Template {
  return { id: '', slug: null, name: '', category: '', subject: '', bodyMd: '', active: true };
}

export function EmailTemplateEditor({ initial }: { initial: Template[] }) {
  const [editing, setEditing] = useState<Template | null>(null);
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove(id: string, slug: string | null) {
    if (slug) {
      alert('System-Vorlagen können nicht gelöscht werden. Texte sind aber editierbar.');
      return;
    }
    if (!confirm('Vorlage wirklich löschen?')) return;
    start(async () => {
      const r = await deleteEmailTemplateAction({ id });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  function save() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const r = await saveEmailTemplateAction({
        id: editing.id || null,
        name: editing.name.trim(),
        category: editing.category?.trim() || null,
        subject: editing.subject.trim(),
        bodyMd: editing.bodyMd.trim(),
        active: editing.active,
      });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      setEditing(null);
    });
  }

  return (
    <div className="space-y-4">
      {initial.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Noch keine E-Mail-Vorlagen definiert.
        </div>
      ) : (
        <ul className="space-y-2">
          {initial.map((t) => (
            <li key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {t.slug ? (
                      <Lock className="h-3.5 w-3.5 text-amber-600" />
                    ) : (
                      <Mail className="h-3.5 w-3.5 text-disabled" />
                    )}
                    <span className="font-medium text-primary">{t.name}</span>
                    {t.slug && (
                      <span className="badge-yellow text-[10px]" title="System-Vorlage — nicht löschbar, Texte editierbar">
                        System · {t.slug}
                      </span>
                    )}
                    {t.category && <span className="badge-gray text-xs">{t.category}</span>}
                    {!t.active && <span className="badge-yellow">deaktiviert</span>}
                  </div>
                  <p className="text-xs text-secondary dark:text-disabled mt-1 truncate">
                    <strong>Betreff:</strong> {t.subject}
                  </p>
                  <p className="text-[11px] text-muted mt-1 line-clamp-2 whitespace-pre-wrap">
                    {t.bodyMd}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    className="text-muted hover:text-brand-700 p-1"
                    title="Bearbeiten"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  {!t.slug && (
                    <button
                      type="button"
                      onClick={() => remove(t.id, t.slug)}
                      disabled={isPending}
                      className="text-disabled hover:text-red-700 p-1"
                      title="Löschen"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!editing && (
        <button
          type="button"
          onClick={() => setEditing(emptyDraft())}
          className="btn-primary inline-flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Neue Vorlage
        </button>
      )}

      {editing && (
        <div className="card p-5 space-y-4 border-2 border-brand-200 dark:border-brand-900/60">
          <h3 className="text-sm font-semibold text-primary">
            {editing.id ? 'Vorlage bearbeiten' : 'Neue Vorlage'}
          </h3>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label">Name (intern)</label>
              <input
                type="text"
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={120}
                placeholder='z. B. „Erinnerung Belege Q1"'
              />
            </div>
            <div>
              <label className="label">Kategorie</label>
              <input
                type="text"
                className="input"
                value={editing.category ?? ''}
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                maxLength={60}
                placeholder="z. B. FiBu"
              />
            </div>
          </div>

          <div>
            <label className="label">Betreff</label>
            <input
              type="text"
              className="input"
              value={editing.subject}
              onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
              maxLength={200}
              placeholder='Wird im Mail-Betreff angezeigt'
            />
          </div>

          <div>
            <label className="label">Mail-Text (Markdown)</label>
            <textarea
              className="input font-mono text-sm"
              rows={10}
              value={editing.bodyMd}
              onChange={(e) => setEditing({ ...editing, bodyMd: e.target.value })}
              maxLength={10_000}
              placeholder={'Sehr geehrte Damen und Herren,\n\nbitte reichen Sie uns die Belege für …\n\nMit freundlichen Grüßen\nIhre Kanzlei'}
            />
            <p className="text-xs text-muted mt-1">
              Platzhalter: <code>{'{{client.name}}'}</code> wird zur Laufzeit durch den Mandantennamen ersetzt.
            </p>
          </div>

          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.active}
              onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
            />
            <span>Aktiv (in Vorlagen-Auswahl sichtbar)</span>
          </label>

          {error && <div className="alert-error-sm">{error}</div>}

          <div className="flex items-center gap-2">
            <button type="button" onClick={save} disabled={isPending} className="btn-primary inline-flex items-center gap-1.5">
              <Save className="h-4 w-4" />
              {isPending ? 'Speichere…' : 'Speichern'}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="btn-secondary inline-flex items-center gap-1.5">
              <X className="h-4 w-4" />
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
