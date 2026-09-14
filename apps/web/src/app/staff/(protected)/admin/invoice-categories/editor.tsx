'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2, Pencil, Receipt, Lock } from 'lucide-react';
import { saveInvoiceCategoryAction, deleteInvoiceCategoryAction } from './actions';
import { confirmDialog } from '@/components/ui/modal';

interface Category {
  id: string;
  name: string;
  slug: string;
  emailTemplateSlug: string | null;
  active: boolean;
}

interface TemplateOption {
  slug: string;
  name: string;
}

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

  async function remove(id: string) {
    if (
      !(await confirmDialog(
        'Rechnungstyp wirklich löschen? Bestehende Rechnungen behalten ihren Typ als „— gelöscht —".',
        { title: 'Rechnungstyp löschen', confirmLabel: 'Löschen', danger: true },
      ))
    )
      return;
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
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setEditing(null);
    });
  }

  return (
    <div className="min-w-0 space-y-4">
      {initial.length === 0 ? (
        <div className="card p-6 text-center text-sm text-muted">
          Noch keine Rechnungstypen — leg den ersten an.
        </div>
      ) : (
        <ul className="space-y-2">
          {initial.map((t) => (
            <li key={t.id} className="card p-4">
              <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
                <div className="min-w-0 w-full flex-1 [overflow-wrap:anywhere]">
                  <div className="flex min-w-0 items-center gap-2 flex-wrap [&>*]:max-w-full">
                    <span className="inline-flex min-w-0 items-start gap-2 font-medium text-primary">
                      <Receipt className="mt-1 h-3.5 w-3.5 shrink-0 text-disabled" />
                      <span className="min-w-0">{t.name}</span>
                    </span>
                    <code className="text-[10px] text-disabled font-mono">{t.slug}</code>
                    {t.emailTemplateSlug && (
                      <span className="badge-gray text-[10px] inline-flex items-center gap-1">
                        <Lock className="h-3 w-3 shrink-0" />
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
                    className="icon-action"
                    title="Bearbeiten"
                    aria-label={`Rechnungstyp „${t.name}“ bearbeiten`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    disabled={isPending}
                    className="icon-action hover:!text-red-700"
                    title="Löschen"
                    aria-label={`Rechnungstyp „${t.name}“ löschen`}
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
        <div className="card min-w-0 space-y-4 p-4 sm:p-6">
          <h2 className="text-base font-semibold text-primary">
            {editing.id ? 'Typ bearbeiten' : 'Neuer Rechnungstyp'}
          </h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <div>
              <label className="label" htmlFor="invoice-category-name">
                Anzeige-Name
              </label>
              <input
                id="invoice-category-name"
                type="text"
                className="input min-w-0"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                maxLength={120}
                placeholder='z. B. „Honorar Q1"'
              />
            </div>
            <div>
              <label className="label" htmlFor="invoice-category-slug">
                Slug{' '}
                <span className="text-xs font-normal text-muted">(optional, sonst aus Name)</span>
              </label>
              <input
                id="invoice-category-slug"
                type="text"
                className="input min-w-0 font-mono"
                value={editing.slug}
                onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
                maxLength={60}
                placeholder="honorar-q1"
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="invoice-category-email-template">
              E-Mail-Vorlage (optional)
            </label>
            <select
              id="invoice-category-email-template"
              className="input min-w-0"
              value={editing.emailTemplateSlug ?? ''}
              onChange={(e) =>
                setEditing({ ...editing, emailTemplateSlug: e.target.value || null })
              }
              aria-describedby="invoice-category-email-template-hint"
            >
              <option value="">— Standard-Rechnungstemplate —</option>
              {emailTemplates.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
            <p id="invoice-category-email-template-hint" className="text-xs text-muted mt-1">
              Pro Rechnungstyp eine eigene Mail-Vorlage. Ohne Auswahl wird das allgemeine
              Rechnungs-Template aus den Einstellungen verwendet.
            </p>
          </div>

          <label className="inline-flex items-start gap-2 text-sm [&>input]:mt-1 [&>input]:shrink-0">
            <input
              type="checkbox"
              checked={editing.active}
              onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
              className="rounded border-strong text-brand-600"
            />
            Aktiv (wählbar im Rechnungs-Formular)
          </label>

          {error && (
            <div className="alert-error-sm" role="alert">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              onClick={save}
              disabled={isPending}
              className="btn-primary text-sm"
            >
              {isPending ? 'Speichere…' : 'Speichern'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="btn-secondary text-sm"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
