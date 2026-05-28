'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { addItemToInstanceAction } from './actions';
import {
  DOCUMENT_CLASSIFICATIONS,
  KIND_LABELS,
  KIND_DESCRIPTIONS,
  defaultConfigFor,
} from '@/server/workflows/step-config';

type StepKind =
  | 'TASK'
  | 'DOCUMENT_UPLOAD'
  | 'CLIENT_REQUEST'
  | 'CLIENT_FORM'
  | 'CLIENT_EMAIL'
  | 'N8N_TRIGGER';

const ALL_KINDS: StepKind[] = ['TASK', 'DOCUMENT_UPLOAD', 'CLIENT_REQUEST', 'CLIENT_FORM', 'CLIENT_EMAIL', 'N8N_TRIGGER'];

interface StaffOption { id: string; fullName: string; }
interface FormTpl { id: string; name: string; }
interface NamedTpl { id: string; name: string; category: string | null; }

export function AddStepForm({
  instanceId,
  staffOptions,
  formTemplates,
  requestTemplates,
  emailTemplates,
}: {
  instanceId: string;
  staffOptions: StaffOption[];
  formTemplates: FormTpl[];
  requestTemplates: NamedTpl[];
  emailTemplates: NamedTpl[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeStaffId, setAssigneeStaffId] = useState('');
  const [kind, setKind] = useState<StepKind>('TASK');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [n8nEvent, setN8nEvent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function changeKind(next: StepKind) {
    setKind(next);
    setConfig(defaultConfigFor(next) as Record<string, unknown>);
  }
  function setCfg(key: string, value: unknown) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  function submit() {
    setError(null);
    if (!title.trim()) { setError('Titel ist Pflicht.'); return; }
    start(async () => {
      const r = await addItemToInstanceAction({
        instanceId,
        title: title.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || null,
        kind,
        config,
        n8nEvent: n8nEvent.trim() || null,
        assigneeStaffId: assigneeStaffId || null,
      });
      if (!r.ok) { setError(r.error ?? 'Fehler.'); return; }
      reset();
      router.refresh();
    });
  }
  function reset() {
    setTitle(''); setDescription(''); setDueDate('');
    setAssigneeStaffId(''); setKind('TASK'); setConfig({}); setN8nEvent('');
    setOpen(false);
  }

  if (!open) {
    return (
      <div className="px-4 py-2 border-t border-subtle">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-muted hover:text-brand-700 dark:hover:text-brand-300 inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          Schritt hinzufügen
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-subtle bg-gray-50/50 dark:bg-gray-900/30 space-y-3">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder='Titel — z. B. „Beleg X anfordern"'
        maxLength={200}
        className="input text-sm"
        autoFocus
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Optionale Beschreibung"
        rows={2}
        maxLength={1000}
        className="input text-sm"
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted mb-1">Schritt-Typ</label>
          <select
            value={kind}
            onChange={(e) => changeKind(e.target.value as StepKind)}
            className="input text-sm"
          >
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
          <p className="text-[10px] text-disabled mt-1 leading-snug">{KIND_DESCRIPTIONS[kind]}</p>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Bearbeiter</label>
          <select
            value={assigneeStaffId}
            onChange={(e) => setAssigneeStaffId(e.target.value)}
            className="input text-sm"
          >
            <option value="">— ich (Standard) —</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.fullName}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Kind-spezifische Felder */}
      <KindFields
        kind={kind}
        config={config}
        setCfg={setCfg}
        formTemplates={formTemplates}
        requestTemplates={requestTemplates}
        emailTemplates={emailTemplates}
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted mb-1">Fälligkeit (optional)</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="input text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">
            n8n-Event <span className="text-disabled">(optional)</span>
          </label>
          <input
            type="text"
            value={n8nEvent}
            onChange={(e) => setN8nEvent(e.target.value)}
            placeholder="z. B. slack-notify"
            maxLength={100}
            className="input text-sm"
          />
        </div>
      </div>

      {error && (
        <div className="alert-error-sm text-xs p-2">{error}</div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={reset} className="text-xs text-muted hover:underline">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="btn-primary text-xs inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          {isPending ? 'Lege an…' : 'Schritt anlegen'}
        </button>
      </div>
    </div>
  );
}

function KindFields({
  kind,
  config,
  setCfg,
  formTemplates,
  requestTemplates,
  emailTemplates,
}: {
  kind: StepKind;
  config: Record<string, unknown>;
  setCfg: (k: string, v: unknown) => void;
  formTemplates: FormTpl[];
  requestTemplates: NamedTpl[];
  emailTemplates: NamedTpl[];
}) {
  switch (kind) {
    case 'TASK':
      return null;

    case 'DOCUMENT_UPLOAD':
      return (
        <div>
          <label className="block text-xs text-muted mb-1">Erwartete Dokumenten-Klasse</label>
          <select
            value={String(config['expectedClassification'] ?? 'GENERAL')}
            onChange={(e) => setCfg('expectedClassification', e.target.value)}
            className="input text-sm"
          >
            {DOCUMENT_CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      );

    case 'CLIENT_REQUEST': {
      const usingTpl = Boolean(config['requestTemplateId']);
      return (
        <div className="space-y-2 rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50/30 dark:bg-amber-900/10 p-2">
          <select
            value={String(config['requestTemplateId'] ?? '')}
            onChange={(e) => setCfg('requestTemplateId', e.target.value || undefined)}
            className="input text-sm"
          >
            <option value="">— Inline-Felder verwenden —</option>
            {requestTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.category ? `[${t.category}] ` : ''}{t.name}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Anforderungs-Titel"
            value={String(config['requestTitle'] ?? '')}
            onChange={(e) => setCfg('requestTitle', e.target.value)}
            maxLength={200}
            className="input text-sm"
            disabled={usingTpl}
          />
          <textarea
            placeholder="Anforderungs-Beschreibung für den Mandanten"
            value={String(config['requestDescription'] ?? '')}
            onChange={(e) => setCfg('requestDescription', e.target.value)}
            rows={2}
            maxLength={5000}
            className="input text-sm"
            disabled={usingTpl}
          />
        </div>
      );
    }

    case 'CLIENT_FORM':
      return (
        <div className="rounded-md border border-indigo-200 dark:border-indigo-900/40 bg-indigo-50/30 dark:bg-indigo-900/10 p-2">
          <select
            value={String(config['formTemplateId'] ?? '')}
            onChange={(e) => setCfg('formTemplateId', e.target.value)}
            className="input text-sm"
          >
            <option value="">— Formular auswählen —</option>
            {formTemplates.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
      );

    case 'CLIENT_EMAIL': {
      const usingTpl = Boolean(config['emailTemplateId']);
      return (
        <div className="space-y-2 rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50/30 dark:bg-blue-900/10 p-2">
          <select
            value={String(config['emailTemplateId'] ?? '')}
            onChange={(e) => setCfg('emailTemplateId', e.target.value || undefined)}
            className="input text-sm"
          >
            <option value="">— Inline-Text verwenden —</option>
            {emailTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.category ? `[${t.category}] ` : ''}{t.name}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Betreff"
            value={String(config['subject'] ?? '')}
            onChange={(e) => setCfg('subject', e.target.value)}
            maxLength={200}
            className="input text-sm"
            disabled={usingTpl}
          />
          <textarea
            placeholder="Mail-Text (Markdown)"
            value={String(config['bodyMd'] ?? '')}
            onChange={(e) => setCfg('bodyMd', e.target.value)}
            rows={4}
            maxLength={10_000}
            className="input text-sm font-mono"
            disabled={usingTpl}
          />
        </div>
      );
    }

    case 'N8N_TRIGGER':
      return (
        <p className="text-xs text-purple-700 dark:text-purple-300 rounded-md bg-purple-50/30 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-900/40 p-2">
          Setzen Sie unten „n8n-Event" — dieser Schritt feuert nur den Webhook.
        </p>
      );
  }
}
