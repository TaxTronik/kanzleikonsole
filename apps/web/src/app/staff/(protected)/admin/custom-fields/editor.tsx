'use client';

import { useState, useTransition } from 'react';
import { slugify as slugifyLib } from '@/lib/slugify';
import { Plus, Trash2, Save, X } from 'lucide-react';
import { saveFieldDefAction, deleteFieldDefAction } from './actions';

type FieldType = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'MONEY' | 'DATE' | 'SELECT' | 'CHECKBOX' | 'URL';
type Kind = 'NATPERS' | 'JURPERS' | 'PERSGES';

const TYPE_LABELS: Record<FieldType, string> = {
  TEXT: 'Text (einzeilig)',
  TEXTAREA: 'Text (mehrzeilig)',
  NUMBER: 'Zahl',
  MONEY: 'Geldbetrag (EUR)',
  DATE: 'Datum',
  SELECT: 'Auswahl',
  CHECKBOX: 'Häkchen',
  URL: 'Link / URL',
};

const KIND_LABELS: Record<Kind, string> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  helpText: string | null;
  appliesTo: Kind[];
  options: Array<{ value: string; label: string }> | null;
  active: boolean;
}

function emptyDraft(): FieldDef & { id: '' } {
  return {
    id: '',
    key: '',
    label: '',
    type: 'TEXT',
    helpText: '',
    appliesTo: [],
    options: null,
    active: true,
  };
}

// Lokale Wrapper: Identifier dürfen nicht mit Zahl/Symbol beginnen → Prefix "f"
function slugify(s: string): string {
  return slugifyLib(s, { maxLength: 50, ensureLetterStart: 'f' });
}

export function CustomFieldsEditor({ initial }: { initial: FieldDef[] }) {
  const [fields, setFields] = useState<FieldDef[]>(initial);
  const [editing, setEditing] = useState<(FieldDef & { id: string }) | null>(null);
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function startNew() {
    setError(null);
    setEditing(emptyDraft());
  }
  function startEdit(f: FieldDef) {
    setError(null);
    setEditing({ ...f });
  }
  function cancel() {
    setEditing(null);
    setError(null);
  }

  function save() {
    if (!editing) return;
    setError(null);
    const key = editing.id ? editing.key : editing.key.trim() || slugify(editing.label);
    if (!key) {
      setError('Bezeichnung oder Schlüssel erforderlich.');
      return;
    }
    start(async () => {
      const r = await saveFieldDefAction({
        id: editing.id || null,
        key,
        label: editing.label.trim(),
        type: editing.type,
        helpText: editing.helpText?.trim() || null,
        appliesTo: editing.appliesTo,
        options: editing.type === 'SELECT' ? editing.options : null,
        active: editing.active,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      // Refresh local state — quick & dirty: location.reload via router refresh
      window.location.reload();
    });
  }

  function remove(id: string) {
    if (!confirm('Feld wirklich löschen? Bestehende Werte gehen verloren.')) return;
    start(async () => {
      const r = await deleteFieldDefAction({ id });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Löschen.');
        return;
      }
      setFields((s) => s.filter((f) => f.id !== id));
    });
  }

  return (
    <div className="space-y-4">
      {fields.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          Noch keine Custom-Felder definiert.
        </div>
      ) : (
        <ul className="space-y-2">
          {fields.map((f) => (
            <li key={f.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-primary">{f.label}</span>
                    <code className="text-xs text-muted font-mono">{f.key}</code>
                    <span className="badge-gray">{TYPE_LABELS[f.type]}</span>
                    {!f.active && <span className="badge-yellow">deaktiviert</span>}
                  </div>
                  <p className="text-xs text-muted mt-1">
                    Gilt für:{' '}
                    {f.appliesTo.length === 0
                      ? 'alle Mandantentypen'
                      : f.appliesTo.map((k) => KIND_LABELS[k]).join(', ')}
                  </p>
                  {f.helpText && <p className="text-xs text-disabled mt-1 italic">{f.helpText}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => startEdit(f)}
                    className="btn-secondary text-xs py-1"
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(f.id)}
                    className="text-disabled hover:text-red-700 p-1"
                    title="Feld löschen"
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
        <button type="button" onClick={startNew} className="btn-primary">
          <Plus className="h-4 w-4" />
          Neues Feld
        </button>
      )}

      {editing && (
        <FieldForm
          draft={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={cancel}
          isPending={isPending}
          error={error}
        />
      )}
    </div>
  );
}

function FieldForm({
  draft,
  onChange,
  onSave,
  onCancel,
  isPending,
  error,
}: {
  draft: FieldDef & { id: string };
  onChange: (d: FieldDef & { id: string }) => void;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
}) {
  const set = <K extends keyof FieldDef>(k: K, v: FieldDef[K]) => onChange({ ...draft, [k]: v });
  const isNew = !draft.id;

  return (
    <div className="card p-6 space-y-4 border-brand-300">
      <h2 className="text-sm font-medium text-primary">
        {isNew ? 'Neues Feld' : `Feld bearbeiten: ${draft.label}`}
      </h2>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Bezeichnung</label>
          <input
            type="text"
            value={draft.label}
            onChange={(e) => set('label', e.target.value)}
            maxLength={120}
            className="input"
            placeholder="z. B. Branche"
          />
        </div>
        <div>
          <label className="label">
            Schlüssel{' '}
            <span className="text-xs text-disabled font-normal">
              {isNew ? '(autom. aus Bezeichnung)' : '(unveränderlich)'}
            </span>
          </label>
          <input
            type="text"
            value={draft.key}
            onChange={(e) => set('key', e.target.value.toLowerCase())}
            maxLength={50}
            className="input font-mono text-sm"
            placeholder={slugify(draft.label)}
            disabled={!isNew}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Typ</label>
          <select
            value={draft.type}
            onChange={(e) => set('type', e.target.value as FieldType)}
            className="input"
            disabled={!isNew}
          >
            {(Object.keys(TYPE_LABELS) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {!isNew && <p className="text-xs text-disabled mt-1">Typ ist nach Anlage fest.</p>}
        </div>
        <div>
          <label className="label">Status</label>
          <label className="flex items-center gap-2 text-sm mt-2">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => set('active', e.target.checked)}
              className="rounded border-strong text-brand-600"
            />
            <span>Aktiv (sichtbar am Mandanten)</span>
          </label>
        </div>
      </div>

      <div>
        <label className="label">Hilfetext (optional)</label>
        <input
          type="text"
          value={draft.helpText ?? ''}
          onChange={(e) => set('helpText', e.target.value)}
          maxLength={300}
          className="input text-sm"
        />
      </div>

      <div>
        <label className="label">Gültig für Mandantentyp</label>
        <p className="text-xs text-muted mb-2">Keine Auswahl = gilt für alle Typen.</p>
        <div className="flex gap-3 flex-wrap">
          {(['NATPERS', 'JURPERS', 'PERSGES'] as Kind[]).map((k) => {
            const checked = draft.appliesTo.includes(k);
            return (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    if (e.target.checked) set('appliesTo', [...draft.appliesTo, k]);
                    else
                      set(
                        'appliesTo',
                        draft.appliesTo.filter((x) => x !== k),
                      );
                  }}
                  className="rounded border-strong text-brand-600"
                />
                <span>{KIND_LABELS[k]}</span>
              </label>
            );
          })}
        </div>
      </div>

      {draft.type === 'SELECT' && (
        <div>
          <label className="label">
            Optionen{' '}
            <span className="text-xs text-disabled font-normal">
              (eine pro Zeile, Format „wert" oder „wert=Anzeige")
            </span>
          </label>
          <textarea
            value={(draft.options ?? [])
              .map((o) => (o.value === o.label ? o.value : `${o.value}=${o.label}`))
              .join('\n')}
            onChange={(e) => set('options', parseOptions(e.target.value))}
            rows={5}
            maxLength={2000}
            placeholder={'klein=Klein (<10 MA)\nmittel=Mittel (10-50)\ngross=Groß (50+)'}
            className="input font-mono text-sm"
          />
        </div>
      )}

      {error && <div className="alert-error-sm">{error}</div>}

      <div className="flex items-center gap-2">
        <button type="button" onClick={onSave} disabled={isPending} className="btn-primary">
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

function parseOptions(text: string): Array<{ value: string; label: string }> {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf('=');
      if (idx < 0) return { value: l, label: l };
      return { value: l.slice(0, idx).trim(), label: l.slice(idx + 1).trim() };
    });
}
