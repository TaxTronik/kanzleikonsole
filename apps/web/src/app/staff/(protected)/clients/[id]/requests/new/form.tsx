'use client';

import { DateTimePicker } from '@/components/datetime-picker';

import { useActionState, useEffect, useId, useState } from 'react';
import { FileText, LoaderCircle, Sparkles } from 'lucide-react';
import {
  FieldError,
  FormErrorSummary,
  fieldErrorId,
  fieldErrorProps,
  type FieldErrors,
} from '@/components/form-errors';
import {
  createQuickRequestAction,
  createRequestAction,
  searchRequestClientsAction,
  type RequestActionResult,
} from '../actions';

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
    result: Required<Pick<RequestActionResult, 'requestId' | 'clientId' | 'nextRequestId'>>,
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
  const submitAction = mode === 'quick' ? createQuickRequestAction : createRequestAction;
  const [state, formAction, isPending] = useActionState<RequestActionResult | null, FormData>(
    submitAction,
    null,
  );
  const fieldErrors = state?.fieldErrors;
  const actionError = state?.error;

  const idPrefix = useId();
  const [clientSearch, setClientSearch] = useState('');
  const [clientOptions, setClientOptions] = useState<RequestClientOption[]>([]);
  const [selectedClient, setSelectedClient] = useState<RequestClientOption | null>(null);
  const [clientSearchPending, setClientSearchPending] = useState(false);
  const [clientSearchError, setClientSearchError] = useState<string | null>(null);
  const [clientSearchLimited, setClientSearchLimited] = useState(false);
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<RequestPriority>('NORMAL');
  const [dueAt, setDueAt] = useState('');
  const [formTemplateId, setFormTemplateId] = useState('');

  const selectedClientId = clientId ?? selectedClient?.id ?? '';

  useEffect(() => {
    if (clientId || selectedClient) return;

    let ignore = false;
    const timeout = window.setTimeout(() => {
      setClientSearchPending(true);
      setClientSearchError(null);
      setClientOptions([]);
      setClientSearchLimited(false);
      void searchRequestClientsAction(clientSearch)
        .then((result) => {
          if (ignore) return;
          setClientSearchPending(false);
          if (!result.ok) {
            setClientSearchError(result.error ?? 'Mandantensuche fehlgeschlagen.');
            setClientOptions([]);
            setClientSearchLimited(false);
            return;
          }
          setClientOptions(result.clients ?? []);
          setClientSearchLimited(Boolean(result.limited));
        })
        .catch(() => {
          if (ignore) return;
          setClientSearchPending(false);
          setClientSearchError('Mandantensuche fehlgeschlagen. Bitte erneut versuchen.');
          setClientOptions([]);
          setClientSearchLimited(false);
        });
    }, 250);

    return () => {
      ignore = true;
      window.clearTimeout(timeout);
    };
  }, [clientId, clientSearch, selectedClient]);

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
          <input type="hidden" name="clientId" value={selectedClientId} />
          <div>
            <label className="label" htmlFor={`${idPrefix}-client-search`}>
              Mandant suchen
            </label>
            <div className="relative">
              <input
                id={`${idPrefix}-client-search`}
                type="search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showClientSuggestions && !selectedClient}
                aria-controls={`${idPrefix}-client-options`}
                value={clientSearch}
                onFocus={() => setShowClientSuggestions(true)}
                onChange={(event) => {
                  setClientSearch(event.target.value);
                  setSelectedClient(null);
                  // Treffer gehören immer exakt zum sichtbaren Suchbegriff.
                  // Alte Resultate dürfen während Debounce/Fehler nicht mehr
                  // anklickbar bleiben, sonst droht eine Anforderung an den
                  // zuvor gesuchten Mandanten.
                  setClientOptions([]);
                  setClientSearchLimited(false);
                  setClientSearchError(null);
                  setClientSearchPending(true);
                  setShowClientSuggestions(true);
                }}
                className="input pr-9"
                placeholder="Name, DATEV- oder Addison-Nr."
                maxLength={100}
                autoComplete="off"
                autoFocus={autoFocus}
                disabled={disabled || isPending}
                {...fieldErrorProps('clientId', fieldErrors)}
              />
              {clientSearchPending && (
                <LoaderCircle
                  className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted"
                  aria-label="Mandanten werden gesucht"
                />
              )}
            </div>

            {selectedClient ? (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-900/20">
                <div>
                  <span className="font-medium text-primary">{selectedClient.name}</span>
                  <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-300">Aktiv</span>
                </div>
                <button
                  type="button"
                  className="text-xs text-brand-700 hover:underline"
                  onClick={() => {
                    setSelectedClient(null);
                    setClientSearch('');
                    setShowClientSuggestions(true);
                  }}
                  disabled={disabled || isPending}
                >
                  Ändern
                </button>
              </div>
            ) : (
              showClientSuggestions && (
                <div
                  id={`${idPrefix}-client-options`}
                  role="listbox"
                  aria-label="Mandantenvorschläge"
                  className="mt-2 max-h-64 overflow-y-auto rounded-md border border-default bg-surface shadow-sm"
                >
                  {clientOptions.map((option) =>
                    option.allowActive ? (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected="false"
                        className="flex w-full items-center justify-between gap-3 border-b border-subtle px-3 py-2 text-left last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800"
                        onClick={() => {
                          setSelectedClient(option);
                          setClientSearch(option.name);
                          setClientSearchPending(false);
                          setShowClientSuggestions(false);
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-primary">
                            {option.name}
                          </span>
                          {(option.datevNo || option.addisonNo) && (
                            <span className="block truncate text-xs text-muted">
                              {option.datevNo ? `DATEV ${option.datevNo}` : ''}
                              {option.datevNo && option.addisonNo ? ' · ' : ''}
                              {option.addisonNo ? `Addison ${option.addisonNo}` : ''}
                            </span>
                          )}
                        </span>
                        <span className="badge-green shrink-0">Aktiv</span>
                      </button>
                    ) : (
                      <div
                        key={option.id}
                        role="option"
                        aria-selected="false"
                        aria-disabled="true"
                        className="flex items-center justify-between gap-3 border-b border-subtle bg-amber-50/60 px-3 py-2 last:border-b-0 dark:bg-amber-900/10"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-secondary">
                            {option.name}
                          </span>
                          <span className="block text-xs text-amber-700 dark:text-amber-300">
                            Noch nicht auswählbar: GwG-Prüfung ausstehend
                          </span>
                        </span>
                        <span className="badge-yellow shrink-0">GwG ausstehend</span>
                      </div>
                    ),
                  )}
                  {!clientSearchPending && clientOptions.length === 0 && (
                    <p className="px-3 py-3 text-sm text-muted">
                      Kein zugänglicher Mandant gefunden.
                    </p>
                  )}
                </div>
              )
            )}
            {clientSearchLimited && !selectedClient && (
              <p className="mt-1 text-xs text-muted">
                Weitere Treffer vorhanden — Suchbegriff bitte genauer eingeben.
              </p>
            )}
            {clientSearchError && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {clientSearchError}
              </p>
            )}
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
