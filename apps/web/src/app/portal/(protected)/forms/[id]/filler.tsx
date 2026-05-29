'use client';

import { useState, useTransition } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import type { FormFieldType } from '@prisma/client';
import { fmtTimeMedium } from '@/lib/fmt';
import {
  saveSubmissionDraftAction,
  submitSubmissionAction,
  uploadFormFileAction,
} from './actions';

interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  helpText: string | null;
  defaultValue: string | null;
  minValue: string | null;
  maxValue: string | null;
  options: Array<{ value: string; label: string }> | null;
}

interface FileAnswer {
  documentId: string;
  fileName: string;
}

type AnswerValue = string | number | boolean | string[] | FileAnswer | null;

export function PortalFormFiller({
  submissionId,
  submitted,
  initialAnswers,
  fields,
}: {
  submissionId: string;
  submitted: boolean;
  initialAnswers: Record<string, unknown>;
  fields: FieldDef[];
}) {
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(() => {
    const out: Record<string, AnswerValue> = {};
    for (const f of fields) {
      const v = initialAnswers[f.key];
      if (v !== undefined) {
        out[f.key] = v as AnswerValue;
      } else if (f.defaultValue) {
        out[f.key] = f.defaultValue;
      } else if (f.type === 'CHECKBOX') {
        out[f.key] = false;
      } else if (f.type === 'MULTISELECT') {
        out[f.key] = [];
      } else if (f.type === 'FILE') {
        out[f.key] = null;
      }
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  function setVal(key: string, value: AnswerValue) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function validate(): string | null {
    for (const f of fields) {
      if (!f.required || f.type === 'INFO_TEXT') continue;
      const v = answers[f.key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
        return `Pflichtfeld nicht ausgefüllt: ${f.label}`;
      }
      if (f.type === 'FILE') {
        const fv = v as FileAnswer;
        if (typeof fv !== 'object' || !fv.documentId) {
          return `Pflichtfeld nicht ausgefüllt: ${f.label}`;
        }
      }
    }
    return null;
  }

  function saveDraft() {
    setError(null);
    start(async () => {
      const r = await saveSubmissionDraftAction({ submissionId, answers });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  function send() {
    setError(null);
    const ve = validate();
    if (ve) {
      setError(ve);
      return;
    }
    if (!confirm('Formular jetzt absenden? Danach sind keine Änderungen mehr möglich.')) return;
    start(async () => {
      const r = await submitSubmissionAction({ submissionId, answers });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Absenden.');
        return;
      }
    });
  }

  return (
    <div className="space-y-4">
      {fields.map((f) => {
        if (f.type === 'INFO_TEXT') {
          return (
            <div key={f.id} className="card p-4 bg-gray-50 text-sm text-secondary whitespace-pre-wrap">
              {f.label}
            </div>
          );
        }
        const v = answers[f.key] ?? null;
        return (
          <div key={f.id} className="card p-4">
            <label className="block text-sm font-medium text-primary mb-1">
              {f.label}
              {f.required && <span className="text-red-700 ml-1">*</span>}
            </label>
            {f.helpText && <p className="text-xs text-muted mb-2">{f.helpText}</p>}
            {renderField(f, v, (next) => setVal(f.key, next), submitted, submissionId)}
          </div>
        );
      })}

      {error && <div className="alert-error-sm">{error}</div>}

      {!submitted && (
        <div className="flex items-center gap-3 sticky bottom-4 bg-surface border border-default rounded-lg p-3 shadow-lg">
          <button type="button" onClick={saveDraft} disabled={isPending} className="btn-secondary">
            {isPending ? 'Speichert…' : 'Entwurf speichern'}
          </button>
          <button type="button" onClick={send} disabled={isPending} className="btn-primary">
            Absenden
          </button>
          {savedAt && (
            <span className="text-xs text-emerald-700">
              Gespeichert um {fmtTimeMedium(new Date(savedAt))}
            </span>
          )}
        </div>
      )}

      {submitted && (
        <div className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">
          ✓ Formular wurde übermittelt. Vielen Dank.
        </div>
      )}
    </div>
  );
}

function renderField(
  f: FieldDef,
  v: AnswerValue,
  set: (next: AnswerValue) => void,
  disabled: boolean,
  submissionId: string,
): React.ReactNode {
  switch (f.type) {
    case 'TEXT':
    case 'EMAIL':
    case 'PHONE':
      return (
        <input
          type={f.type === 'EMAIL' ? 'email' : f.type === 'PHONE' ? 'tel' : 'text'}
          value={(v as string | undefined) ?? ''}
          onChange={(e) => set(e.target.value)}
          disabled={disabled}
          className="input"
        />
      );
    case 'TEXTAREA':
      return (
        <textarea
          value={(v as string | undefined) ?? ''}
          onChange={(e) => set(e.target.value)}
          disabled={disabled}
          rows={4}
          className="input"
        />
      );
    case 'NUMBER':
      return (
        <input
          type="number"
          value={(v as number | string | undefined) ?? ''}
          min={f.minValue ?? undefined}
          max={f.maxValue ?? undefined}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
          disabled={disabled}
          className="input"
        />
      );
    case 'MONEY':
      return (
        <div className="relative">
          <input
            type="number"
            step="0.01"
            value={(v as number | string | undefined) ?? ''}
            min={f.minValue ?? undefined}
            max={f.maxValue ?? undefined}
            onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
            disabled={disabled}
            className="input pr-10"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">€</span>
        </div>
      );
    case 'DATE':
      return (
        <input
          type="date"
          value={(v as string | undefined) ?? ''}
          min={f.minValue ?? undefined}
          max={f.maxValue ?? undefined}
          onChange={(e) => set(e.target.value)}
          disabled={disabled}
          className="input"
        />
      );
    case 'SELECT':
      return (
        <select
          value={(v as string | undefined) ?? ''}
          onChange={(e) => set(e.target.value)}
          disabled={disabled}
          className="input"
        >
          <option value="">— bitte wählen —</option>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case 'MULTISELECT': {
      const arr = (v as string[] | undefined) ?? [];
      return (
        <div className="space-y-1">
          {(f.options ?? []).map((o) => {
            const checked = arr.includes(o.value);
            return (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    if (e.target.checked) set([...arr, o.value]);
                    else set(arr.filter((x) => x !== o.value));
                  }}
                  disabled={disabled}
                  className="rounded border-strong text-brand-600"
                />
                <span>{o.label}</span>
              </label>
            );
          })}
        </div>
      );
    }
    case 'CHECKBOX':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(v)}
            onChange={(e) => set(e.target.checked)}
            disabled={disabled}
            className="rounded border-strong text-brand-600"
          />
          <span>Ja</span>
        </label>
      );
    case 'FILE':
      return (
        <FileUploadField
          fieldKey={f.key}
          submissionId={submissionId}
          value={v as FileAnswer | null}
          set={set}
          disabled={disabled}
        />
      );
    case 'INFO_TEXT':
      return null;
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function FileUploadField({
  fieldKey,
  submissionId,
  value,
  set,
  disabled,
}: {
  fieldKey: string;
  submissionId: string;
  value: FileAnswer | null;
  set: (next: AnswerValue) => void;
  disabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setUploadError(`Datei zu groß (max. ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
      return;
    }
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const r = await uploadFormFileAction({
        submissionId,
        fieldKey,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64,
      });
      if (!r.ok || !r.documentId) {
        setUploadError(r.error ?? 'Upload fehlgeschlagen.');
        return;
      }
      set({ documentId: r.documentId, fileName: file.name });
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  if (value && value.documentId) {
    return (
      <div className="flex items-center gap-2">
        <a
          href={`/api/portal/documents/${value.documentId}/download`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
        >
          <FileText className="h-4 w-4" /> {value.fileName}
        </a>
        {!disabled && (
          <button
            type="button"
            onClick={() => set(null)}
            className="text-disabled hover:text-red-700 p-1"
            title="Datei entfernen"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label
        className={`inline-flex items-center gap-2 cursor-pointer btn-secondary ${
          disabled || uploading ? 'opacity-50 cursor-not-allowed' : ''
        }`}
      >
        <Upload className="h-4 w-4" />
        {uploading ? 'Lädt hoch…' : 'Datei auswählen'}
        <input
          type="file"
          className="hidden"
          onChange={onPick}
          disabled={disabled || uploading}
        />
      </label>
      {uploadError && <div className="text-xs text-red-700">{uploadError}</div>}
      <p className="text-xs text-muted">Max. 10 MB.</p>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}
