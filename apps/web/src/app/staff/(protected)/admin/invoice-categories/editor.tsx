'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Pencil, Receipt, Lock } from 'lucide-react';
import { saveInvoiceCategoryAction, deleteInvoiceCategoryAction } from './actions';

interface Category {
  id: string;
  name: string;
  slug: string;
  emailTemplateSlug: string | null;
  active: boolean;
}

interface TemplateOption { slug: string; name: string; }

function emptyDraft(): Category {
  return { id: '', name: '', slug: '', emailTemplateSlug: null, active: true };
}

export function InvoiceCategoryEditor({
  initial,
  emailTemplates,
}: {
  initial: Category[];
  emailTemplates: TemplateOption[];
}) {
  const [editing, setEditing] = useState<Category | null>(null);
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove(id: string) {
    if (!confirm('Rechnungstyp wirklich löschen? Bestehende Rechnungen behalten ihren Typ als „— gelöscht —".')) return;
    start(async () => {
      const r = await deleteInvoiceCategoryAction({ id });
      if (!r.ok) setError(r.error ?? 'Fehler.');
    });
  }

  function save() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const r = await saveInvoiceCategoryAction({
        id: editing.id || null,
        name: editing.name.trim(),
        slug: editing.slug.trim(),
        emailTemplateSlug: editing.emailTemplateSlug ?? '',
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
          Noch keine Rechnungstypen — leg den ersten an.
        </div>
      ) : (
        <ul className="space-y-2">
          {initial.map((t) => (
            <li key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Receipt className="h-3.5 w-3.5 text-disabled" />
                    <span className="font-medium text-primary">{t.name}</span>
                    <code className="text-[10px] text-disabled font-mono">{t.slug}</code>
                    {t.emailTemplateSlug && (
                      <span className="badge-gray text-[10px] inline-flex items-center gap-1">
                        <Lock className="h-2.5 w-2.5" />
                        Mail-Vorlage: {t.emailTemplateSlug}
                      </span>
                    )}
                    {!t.active && <span className="badge-yellow">deaktiviert</span>}
                  </div>
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
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    disabled={isPending}
                    className="text-disabled hover:text-red-700 p-1"
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
          onClick={() => setEditing(emptyDraft())}
          className="btn-primary inline-flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Neuer Typ
        </button>
      )}

      {editing && (
        <div className="card p-5 space-y-4 border-2 border-brand-200 dark:border-brand-900/60">
          <h3 className="text-sm font-semibold text-primary">
            {editing.id ? 'Typ bearbeiten' : 'Neuer Rechnungstyp'}
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Anzeige-Name</label>
              <input
                type="text"
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={120}
                placeholder='z. B. „Honorar Q1"'
              />
            </div>
            <div>
              <label className="label">
                Slug <span className="text-xs font-normal text-muted">(optional, sonst aus Name)</span>
              </label>
              <input
                type="text"
                className="input font-mono"
                value={editing.slug}
                onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
                maxLength={60}
                placeholder="honorar-q1"
              />
            </div>
          </div>

          <div>
            <label className="label">E-Mail-Vorlage (optional)</label>
            <select
              className="input"
              value={editing.emailTemplateSlug ?? ''}
              onChange={(e) => setEditing({ ...editing, emailTemplateSlug: e.target.value || null })}
            >
              <option value="">— Standard-Rechnungstemplate —</option>
              {emailTemplates.map((t) => (
                <option key={t.slug} value={t.slug}>{t.name} ({t.slug})</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">
              Pro Rechnungstyp eine eigene Mail-Vorlage. Ohne Auswahl wird das
              allgemeine Rechnungs-Template aus den Einstellungen verwendet.
            </p>
          </div>

          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.active}
              onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
              className="rounded border-strong text-brand-600"
            />
            Aktiv (wählbar im Rechnungs-Formular)
          </label>

          {error && <div className="rounded-md bg-red-50 p-2 text-xs text-red-700">{error}</div>}

          <div className="flex items-center gap-2 pt-2">
            <button type="button" onClick={save} disabled={isPending} className="btn-primary text-sm">
              {isPending ? 'Speichere…' : 'Speichern'}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="btn-secondary text-sm">
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
