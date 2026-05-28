'use client';

import { useState, useTransition } from 'react';
import { slugify as slugifyLib } from '@/lib/slugify';
import { Plus, Trash2 } from 'lucide-react';
import { saveFormTemplateAction } from '../actions';
import { SortableList, DragHandle } from '@/components/sortable-list';

type FieldType =
  | 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'MONEY' | 'DATE' | 'EMAIL' | 'PHONE'
  | 'SELECT' | 'MULTISELECT' | 'CHECKBOX' | 'FILE' | 'INFO_TEXT';

const TYPE_LABELS: Record<FieldType, string> = {
  TEXT: 'Text (einzeilig)',
  TEXTAREA: 'Text (mehrzeilig)',
  NUMBER: 'Zahl',
  MONEY: 'Geldbetrag (EUR)',
  DATE: 'Datum',
  EMAIL: 'E-Mail',
  PHONE: 'Telefon',
  SELECT: 'Auswahl (eine)',
  MULTISELECT: 'Auswahl (mehrere)',
  CHECKBOX: 'Häkchen',
  FILE: 'Datei-Upload',
  INFO_TEXT: 'Hinweis (read-only)',
};

interface FieldDraft {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helpText: string;
  defaultValue: string;
  minValue: string;
  maxValue: string;
  /** Eine Option pro Zeile, Format `wert` oder `wert=Anzeige` */
  options: string;
}

function emptyField(): FieldDraft {
  return {
    key: '',
    label: '',
    type: 'TEXT',
    required: false,
    helpText: '',
    defaultValue: '',
    minValue: '',
    maxValue: '',
    options: '',
  };
}

function slugify(s: string): string {
  return slugifyLib(s, { maxLength: 60 });
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

export function FormEditor({
  templateId,
  initialDescription,
  initialIntroMd,
  initialFields,
}: {
  templateId: string;
  initialDescription: string;
  initialIntroMd: string;
  initialFields: FieldDraft[];
}) {
  const [description, setDescription] = useState(initialDescription);
  const [introMd, setIntroMd] = useState(initialIntroMd);
  const [fields, setFields] = useState<FieldDraft[]>(
    initialFields.length > 0 ? initialFields : [emptyField()],
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  function update(i: number, patch: Partial<FieldDraft>) {
    setFields((s) => s.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function add() { setFields((s) => [...s, emptyField()]); }
  function remove(i: number) { setFields((s) => s.filter((_, idx) => idx !== i)); }
  function reorder(from: number, to: number) {
    setFields((s) => {
      const next = [...s];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }

  function save() {
    setError(null);
    const cleaned: FieldDraft[] = [];
    for (const f of fields) {
      const label = f.label.trim();
      if (!label && f.type !== 'INFO_TEXT') continue;
      let key = f.key.trim();
      if (!key) key = slugify(label) || `feld_${cleaned.length + 1}`;
      cleaned.push({ ...f, key, label: label || key });
    }
    if (cleaned.length === 0) {
      setError('Mindestens ein Feld mit Bezeichnung erforderlich.');
      return;
    }
    const keys = new Set<string>();
    for (const f of cleaned) {
      if (keys.has(f.key)) {
        setError(`Doppelter Feld-Schlüssel: ${f.key}`);
        return;
      }
      keys.add(f.key);
    }

    start(async () => {
      const r = await saveFormTemplateAction({
        templateId,
        description: description.trim() || null,
        introMd: introMd.trim() || null,
        fields: cleaned.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
          helpText: f.helpText.trim() || null,
          defaultValue: f.defaultValue.trim() || null,
          minValue: f.minValue.trim() || null,
          maxValue: f.maxValue.trim() || null,
          options:
            f.type === 'SELECT' || f.type === 'MULTISELECT'
              ? parseOptions(f.options)
              : null,
        })),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <div className="space-y-6">
      <div className="card p-6 space-y-4">
        <div>
          <label className="label">Beschreibung (intern)</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} className="input" />
        </div>
        <div>
          <label className="label">Intro für den Mandanten (Markdown, optional)</label>
          <textarea
            value={introMd}
            onChange={(e) => setIntroMd(e.target.value)}
            rows={3}
            maxLength={5000}
            className="input"
            placeholder="Bitte füllen Sie das Formular für die Erstellung Ihrer Steuererklärung 2025 aus. …"
          />
        </div>
      </div>

      <SortableList
        count={fields.length}
        onReorder={reorder}
        renderItem={(i, handle) => {
          const f = fields[i]!;
          return (
          <div className="card p-4">
            <div className="flex items-start gap-3">
              <div className="flex flex-col items-center pt-1 gap-1">
                <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <DragHandle handle={handle} />
              </div>
              <div className="flex-1 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-muted mb-1">Bezeichnung</label>
                    <input
                      type="text"
                      placeholder={f.type === 'INFO_TEXT' ? 'Hinweistext (wird angezeigt)' : 'z. B. Familienstand'}
                      value={f.label}
                      onChange={(e) => update(i, { label: e.target.value })}
                      maxLength={200}
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted mb-1">Typ</label>
                    <select value={f.type} onChange={(e) => update(i, { type: e.target.value as FieldType })} className="input">
                      {Object.entries(TYPE_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {f.type !== 'INFO_TEXT' && (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-muted mb-1">
                        Schlüssel <span className="text-disabled font-normal">(autom.)</span>
                      </label>
                      <input
                        type="text"
                        value={f.key}
                        onChange={(e) => update(i, { key: e.target.value })}
                        maxLength={60}
                        placeholder={slugify(f.label)}
                        className="input font-mono text-xs"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-muted mb-1">Hilfetext</label>
                      <input
                        type="text"
                        value={f.helpText}
                        onChange={(e) => update(i, { helpText: e.target.value })}
                        maxLength={300}
                        className="input text-sm"
                      />
                    </div>
                  </div>
                )}
                {(f.type === 'SELECT' || f.type === 'MULTISELECT') && (
                  <div>
                    <label className="block text-xs text-muted mb-1">
                      Optionen <span className="text-disabled font-normal">(eine pro Zeile, Format „wert" oder „wert=Anzeige")</span>
                    </label>
                    <textarea
                      value={f.options}
                      onChange={(e) => update(i, { options: e.target.value })}
                      rows={4}
                      maxLength={2000}
                      placeholder={'verheiratet=Verheiratet\nledig=Ledig\ngeschieden=Geschieden'}
                      className="input font-mono text-sm"
                    />
                  </div>
                )}
                {(f.type === 'NUMBER' || f.type === 'MONEY' || f.type === 'DATE') && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-muted mb-1">Min</label>
                      <input
                        type="text"
                        value={f.minValue}
                        onChange={(e) => update(i, { minValue: e.target.value })}
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-1">Max</label>
                      <input
                        type="text"
                        value={f.maxValue}
                        onChange={(e) => update(i, { maxValue: e.target.value })}
                        className="input"
                      />
                    </div>
                  </div>
                )}
                {f.type !== 'INFO_TEXT' && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => update(i, { required: e.target.checked })}
                      className="rounded border-strong text-brand-600"
                    />
                    <span>Pflichtfeld</span>
                  </label>
                )}
              </div>
              <button type="button" onClick={() => remove(i)} className="text-disabled hover:text-red-700 p-1" title="Feld entfernen">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          );
        }}
      />

      <div className="flex items-center gap-3">
        <button type="button" onClick={add} className="btn-secondary">
          <Plus className="h-4 w-4" /> Feld hinzufügen
        </button>
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          {isPending ? 'Speichert…' : 'Vorlage speichern'}
        </button>
        {savedAt && (
          <span className="text-xs text-emerald-700">
            Gespeichert um {new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium' }).format(new Date(savedAt))}
          </span>
        )}
      </div>
      {error && <div className="alert-error-sm">{error}</div>}
    </div>
  );
}
