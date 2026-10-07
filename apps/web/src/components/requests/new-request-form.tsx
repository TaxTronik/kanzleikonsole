'use client';

import { DateTimePicker } from '@/components/datetime-picker';

import { useActionState, useEffect, useId, useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import {
  FieldError,
  FormErrorSummary,
  fieldErrorId,
  fieldErrorProps,
  type FieldErrors,
} from '@/components/form-errors';
import { ClientCombobox, type ClientComboboxValue } from '@/components/ui/client-combobox';
import type { ActionResult } from '@/server/actions/types';

/** Ergebnis der Anlage-Actions (createRequestAction/createQuickRequestAction). */
export type RequestCreationResult = ActionResult & {
  requestId?: string;
  clientId?: string;
  nextRequestId?: string;
};

/**
 * Server-Action der Anlage. Die Route übergibt createRequestAction, der
 * Schnelldialog createQuickRequestAction (K-08: components/ importiert nicht aus
 * app/; beide Actions liegen in app/staff/(protected)/clients/[id]/requests/actions.ts).
 */
export type RequestCreationAction = (
  prev: RequestCreationResult | null,
  formData: FormData,
) => Promise<RequestCreationResult>;

export type RequestPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface RequestTemplateOption {
  id: string;
  name: string;
  category: string | null;
  title: string;
  description: string;
  priority: RequestPriority;
  dueAfterDays: number | null;
  formTemplateId: string | null;
}

export interface RequestFormTemplateOption {
  id: string;
  name: string;
}

export interface RequestClientOption {
  id: string;
  name: string;
  datevNo: string | null;
  addisonNo: string | null;
  allowActive: boolean;
}

interface Props {
  action: RequestCreationAction;
  requestId: string;
  clientId?: string;
  disabled?: boolean;
  templates: RequestTemplateOption[];
  formTemplates: RequestFormTemplateOption[];
  templatesLimited?: boolean;
  formTemplatesLimited?: boolean;
  mode?: 'page' | 'quick';
  autoFocus?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onCreated?: (
    result: Required<Pick<RequestCreationResult, 'requestId' | 'clientId' | 'nextRequestId'>>,
  ) => void;
}

function isoLocalForDate(d: Date): string {
  // Liefert den lokalen Picker-Wert im Format YYYY-MM-DDTHH:mm.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RequestFieldError({ name, fieldErrors }: { name: string; fieldErrors?: FieldErrors }) {
  return <FieldError name={name} errors={fieldErrors?.[name]} />;
}

function requestFieldInvalid(name: string, fieldErrors?: FieldErrors): boolean {
  return Boolean(fieldErrors?.[name]?.length);
}

function requestFieldDescription(name: string, fieldErrors?: FieldErrors): string | undefined {
  return requestFieldInvalid(name, fieldErrors) ? fieldErrorId(name) : undefined;
}

export function NewRequestForm({
  action,
  requestId,
  clientId,
  disabled,
  templates,
  formTemplates,
  templatesLimited = false,
  formTemplatesLimited = false,
  mode = 'page',
  autoFocus = false,
  onPendingChange,
  onCreated,
}: Props) {
  const [state, formAction, isPending] = useActionState<RequestCreationResult | null, FormData>(
    action,
    null,
  );
  const fieldErrors = state?.fieldErrors;
  const actionError = state?.error;

  const idPrefix = useId();
  const [selectedClient, setSelectedClient] = useState<ClientComboboxValue | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<RequestPriority>('NORMAL');
  const [dueAt, setDueAt] = useState('');
  const [formTemplateId, setFormTemplateId] = useState('');

  const selectedClientId = clientId ?? selectedClient?.id ?? '';

  useEffect(() => onPendingChange?.(isPending), [isPending, onPendingChange]);
  useEffect(() => {
    if (
      mode !== 'quick' ||
      !state?.ok ||
      !state.requestId ||
      !state.clientId ||
      !state.nextRequestId
    )
      return;
    onCreated?.({
      requestId: state.requestId,
      clientId: state.clientId,
      nextRequestId: state.nextRequestId,
    });
  }, [mode, onCreated, state]);

  function applyTemplate(id: string) {
    setSelectedTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setTitle(t.title);
    setDescription(t.description);
    setPriority(t.priority);
    if (t.dueAfterDays !== null) {
      const due = new Date();
      due.setDate(due.getDate() + t.dueAfterDays);
      setDueAt(isoLocalForDate(due));
    } else {
      setDueAt('');
    }
    setFormTemplateId(t.formTemplateId ?? '');
  }

  // Templates nach Kategorie gruppieren für ein sauberes optgroup-Dropdown
  const grouped = new Map<string, RequestTemplateOption[]>();
  for (const t of templates) {
    const key = t.category?.trim() || 'Allgemein';
    const arr = grouped.get(key) ?? [];
    arr.push(t);
    grouped.set(key, arr);
  }

  return (
    <form
      action={formAction}
      className="space-y-4"
      onSubmit={() => onPendingChange?.(true)}
      aria-busy={isPending}
    >
      <input type="hidden" name="requestId" value={requestId} />
      <FormErrorSummary
        error={actionError}
        fieldErrors={fieldErrors}
        fieldIds={{
          clientId: `${idPrefix}-client-search`,
          title: 'title',
          description: 'description',
          priority: 'priority',
          dueAt: 'dueAt',
          formTemplateId: 'request-form-template',
        }}
      />
      {clientId ? (
        <input type="hidden" name="clientId" value={clientId} />
      ) : (
        <div className="rounded-md border border-default p-3 space-y-3">
          <div>
            <label className="label" htmlFor={`${idPrefix}-client-search`}>
              Mandant suchen
            </label>
            {/* Gemeinsame Serversuche (GET /api/staff/clients/search): nicht
                anonymisierte, zugängliche Mandanten; GwG-offene sichtbar, aber
                nicht wählbar. */}
            <ClientCombobox
              id={`${idPrefix}-client-search`}
              name="clientId"
              filters={['notAnonymized']}
              inactive="disabled"
              value={selectedClient}
              onChange={setSelectedClient}
              required
              autoFocus={autoFocus}
              disabled={disabled || isPending}
              {...fieldErrorProps('clientId', fieldErrors)}
            />
            <p className="mt-1 text-xs text-muted">
              Mandanten mit ausstehender GwG-Prüfung werden angezeigt, können aber noch keine
              Portal-Anforderung erhalten.
            </p>
            <RequestFieldError name="clientId" fieldErrors={fieldErrors} />
          </div>
        </div>
      )}
      {selectedTemplateId && <input type="hidden" name="templateId" value={selectedTemplateId} />}
      <input type="hidden" name="formTemplateId" value={formTemplateId} />
      {templates.length > 0 && (
        <div className="rounded-md border border-brand-200 bg-brand-50/30 p-3">
          <label className="label flex items-center gap-1.5" htmlFor="template">
            <Sparkles className="h-3.5 w-3.5 text-brand-600" />
            Vorlage anwenden
          </label>
          <select
            id="template"
            value={selectedTemplateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="input"
            disabled={disabled || isPending}
          >
            <option value="">— keine Vorlage (manuell ausfüllen) —</option>
            {Array.from(grouped.entries()).map(([cat, list]) => (
              <optgroup key={cat} label={cat}>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.formTemplateId ? ' · mit Formular' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {templatesLimited && (
            <p className="text-xs text-muted mt-1">
              Es werden die ersten 100 aktiven Anforderungsvorlagen angezeigt.
            </p>
          )}
        </div>
      )}

      <div>
        <label className="label" htmlFor="title">
          Titel
        </label>
        <input
          id="title"
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input"
          placeholder="z. B. Belege Q3 2025"
          required
          minLength={2}
          maxLength={200}
          autoFocus={autoFocus && Boolean(clientId)}
          disabled={disabled || isPending}
          {...fieldErrorProps('title', fieldErrors)}
        />
        <RequestFieldError name="title" fieldErrors={fieldErrors} />
      </div>

      <div>
        <label className="label" htmlFor="description">
          Beschreibung
        </label>
        <textarea
          id="description"
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          className="input"
          placeholder="Was wird vom Mandanten benötigt?"
          required
          minLength={2}
          maxLength={5000}
          disabled={disabled || isPending}
          {...fieldErrorProps('description', fieldErrors)}
        />
        <RequestFieldError name="description" fieldErrors={fieldErrors} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="priority">
            Priorität
          </label>
          <select
            id="priority"
            name="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as RequestPriority)}
            className="input"
            disabled={disabled || isPending}
            {...fieldErrorProps('priority', fieldErrors)}
          >
            <option value="LOW">Niedrig</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">Hoch</option>
            <option value="URGENT">Dringend</option>
          </select>
          <RequestFieldError name="priority" fieldErrors={fieldErrors} />
        </div>

        <div>
          <label className="label" htmlFor="dueAt">
            Fällig am
          </label>
          {/* Eigener Picker statt nativem datetime-local: Firefox bietet dort
              keine Uhrzeit-Auswahl an. Ausgabeformat bleibt der lokale
              YYYY-MM-DDTHH:MM-Stempel (Berlin-Wanduhr), den die Action via
              berlinWallClockToUtc konvertiert. */}
          <DateTimePicker
            id="dueAt"
            name="dueAt"
            value={dueAt}
            onChange={setDueAt}
            disabled={disabled || isPending}
            ariaInvalid={requestFieldInvalid('dueAt', fieldErrors)}
            ariaDescribedBy={requestFieldDescription('dueAt', fieldErrors)}
          />
          <RequestFieldError name="dueAt" fieldErrors={fieldErrors} />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="request-form-template">
          Formular mitschicken (optional)
        </label>
        <select
          id="request-form-template"
          value={formTemplateId}
          onChange={(e) => setFormTemplateId(e.target.value)}
          className="input"
          disabled={disabled || isPending}
          {...fieldErrorProps('formTemplateId', fieldErrors)}
        >
          <option value="">— kein Formular —</option>
          {formTemplates.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {formTemplatesLimited && (
          <p className="text-xs text-muted mt-1">
            Es werden die ersten 100 aktiven Formulare sowie alle von sichtbaren
            Anforderungsvorlagen benötigten Formulare angezeigt.
          </p>
        )}
        {formTemplateId && (
          <p className="text-xs text-brand-700 mt-1 flex items-center gap-1">
            <FileText className="h-3 w-3" />
            Der Mandant bekommt das Formular in seinem Portal angezeigt.
          </p>
        )}
        <RequestFieldError name="formTemplateId" fieldErrors={fieldErrors} />
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          className="btn-primary"
          disabled={isPending || disabled || !selectedClientId}
        >
          {isPending ? 'Wird erstellt…' : 'Anforderung erstellen'}
        </button>
      </div>
    </form>
  );
}
