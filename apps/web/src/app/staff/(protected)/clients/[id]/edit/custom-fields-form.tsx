'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { saveCustomFieldValuesAction } from '../../../admin/custom-fields/actions';
import { fmtTimeMedium } from '@/lib/fmt';

type FieldType =
  | 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'MONEY' | 'DATE' | 'SELECT' | 'CHECKBOX' | 'URL';

interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  helpText: string | null;
  options: Array<{ value: string; label: string }> | null;
}

type Value = string | number | boolean | null;

export function CustomFieldsForm({
  clientId,
  defs,
  initialValues,
}: {
  clientId: string;
  defs: FieldDef[];
  initialValues: Record<string, unknown>;
}) {
  const [values, setValues] = useState<Record<string, Value>>(() => {
    const out: Record<string, Value> = {};
    for (const d of defs) {
      const v = initialValues[d.id];
      if (v === null || v === undefined) {
        out[d.id] = d.type === 'CHECKBOX' ? false : '';
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[d.id] = v;
      } else {
        out[d.id] = String(v);
      }
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  function setVal(id: string, v: Value) {
    setValues((s) => ({ ...s, [id]: v }));
  }

  function save() {
    setError(null);
    start(async () => {
      const r = await saveCustomFieldValuesAction({ clientId, values });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <div className="card p-6">
      <h2 className="text-sm font-medium text-primary mb-4">Custom-Felder</h2>
      <div className="grid grid-cols-2 gap-4">
        {defs.map((d) => (
          <div key={d.id} className={d.type === 'TEXTAREA' ? 'col-span-2' : undefined}>
            <label className="label-sm">{d.label}</label>
            {renderInput(d, values[d.id] ?? null, (v) => setVal(d.id, v))}
            {d.helpText && <p className="text-xs text-disabled mt-1">{d.helpText}</p>}
          </div>
        ))}
      </div>
      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 mt-4">{error}</div>}
      <div className="flex items-center gap-3 justify-end mt-4">
        {savedAt && (
          <span className="text-xs text-emerald-700">
            Gespeichert {fmtTimeMedium(new Date(savedAt))}
          </span>
        )}
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          {isPending ? 'Speichert…' : 'Custom-Felder speichern'}
        </button>
      </div>
    </div>
  );
}

function renderInput(d: FieldDef, v: Value, set: (v: Value) => void): ReactNode {
  switch (d.type) {
    case 'TEXTAREA':
      return (
        <textarea
          value={(v as string) ?? ''}
          onChange={(e) => set(e.target.value)}
          rows={3}
          maxLength={2000}
          className="input"
        />
      );
    case 'NUMBER':
      return (
        <input
          type="number"
          value={(v as number | string) ?? ''}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
          className="input"
        />
      );
    case 'MONEY':
      return (
        <div className="relative">
          <input
            type="number"
            step="0.01"
            value={(v as number | string) ?? ''}
            onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
            className="input pr-10"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">€</span>
        </div>
      );
    case 'DATE':
      return (
        <input
          type="date"
          value={(v as string) ?? ''}
          onChange={(e) => set(e.target.value)}
          className="input"
        />
      );
    case 'SELECT':
      return (
        <select
          value={(v as string) ?? ''}
          onChange={(e) => set(e.target.value)}
          className="input"
        >
          <option value="">— bitte wählen —</option>
          {(d.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case 'CHECKBOX':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(v)}
            onChange={(e) => set(e.target.checked)}
            className="rounded border-strong text-brand-600"
          />
          <span>Ja</span>
        </label>
      );
    case 'URL':
      return (
        <input
          type="url"
          value={(v as string) ?? ''}
          onChange={(e) => set(e.target.value)}
          className="input"
        />
      );
    case 'TEXT':
    default:
      return (
        <input
          type="text"
          value={(v as string) ?? ''}
          onChange={(e) => set(e.target.value)}
          maxLength={500}
          className="input"
        />
      );
  }
}
