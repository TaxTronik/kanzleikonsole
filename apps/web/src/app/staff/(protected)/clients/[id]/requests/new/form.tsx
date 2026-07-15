'use client';

import { useActionState, useEffect, useId, useMemo, useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { createQuickRequestAction, createRequestAction, type ActionResult } from '../actions';

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
}

interface Props {
  requestId: string;
  clientId?: string;
  clients?: RequestClientOption[];
  disabled?: boolean;
  templates: RequestTemplateOption[];
  formTemplates: RequestFormTemplateOption[];
  templatesLimited?: boolean;
  formTemplatesLimited?: boolean;
  mode?: 'page' | 'quick';
  autoFocus?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onCreated?: (
    result: Required<Pick<ActionResult, 'requestId' | 'clientId' | 'nextRequestId'>>,
  ) => void;
}

function isoLocalForDate(d: Date): string {
  // Liefert YYYY-MM-DDTHH:mm für <input type="datetime-local"> in lokaler TZ
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewRequestForm({
  requestId,
  clientId,
  clients = [],
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
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    submitAction,
    null,
  );

  const idPrefix = useId();
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState(clientId ?? '');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<RequestPriority>('NORMAL');
  const [dueAt, setDueAt] = useState('');
  const [formTemplateId, setFormTemplateId] = useState('');

  const filteredClients = useMemo(() => {
    const query = clientSearch.trim().toLocaleLowerCase('de-DE');
    if (!query) return clients;
    const matches = clients.filter((client) =>
      [client.name, client.datevNo ?? '', client.addisonNo ?? ''].some((value) =>
        value.toLocaleLowerCase('de-DE').includes(query),
      ),
    );
    const selected = clients.find((client) => client.id === selectedClientId);
    if (selected && !matches.some((client) => client.id === selected.id)) matches.unshift(selected);
    return matches;
  }, [clientSearch, clients, selectedClientId]);

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
      {clientId ? (
        <input type="hidden" name="clientId" value={clientId} />
      ) : (
        <div className="rounded-md border border-default p-3 space-y-3">
          <div>
            <label className="label" htmlFor={`${idPrefix}-client-search`}>
              Mandant suchen
            </label>
            <input
              id={`${idPrefix}-client-search`}
              type="search"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              className="input"
              placeholder="Name, DATEV- oder Addison-Nr."
              autoFocus={autoFocus}
              disabled={disabled || isPending}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${idPrefix}-client`}>
              Mandant
            </label>
            <select
              id={`${idPrefix}-client`}
              name="clientId"
              value={selectedClientId}
              onChange={(event) => setSelectedClientId(event.target.value)}
              className="input"
              required
              disabled={disabled || isPending}
            >
              <option value="">— bitte auswählen —</option>
              {filteredClients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                  {client.datevNo ? ` · DATEV ${client.datevNo}` : ''}
                  {client.addisonNo ? ` · Addison ${client.addisonNo}` : ''}
                </option>
              ))}
            </select>
            {filteredClients.length === 0 && (
              <p className="text-xs text-muted mt-1">Kein zugänglicher aktiver Mandant gefunden.</p>
            )}
            {state?.fieldErrors?.['clientId'] && (
              <p className="text-xs text-red-600 mt-1">{state.fieldErrors['clientId']}</p>
            )}
          </div>
        </div>
      )}
      {selectedTemplateId && <input type="hidden" name="templateId" value={selectedTemplateId} />}
      <input type="hidden" name="formTemplateId" value={formTemplateId} />
      <input
        type="hidden"
        name="dueAt"
        value={
          dueAt && !Number.isNaN(new Date(dueAt).getTime()) ? new Date(dueAt).toISOString() : ''
        }
      />

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
        />
        {state?.fieldErrors?.['title'] && (
          <p className="text-xs text-red-600 mt-1">{state.fieldErrors['title']}</p>
        )}
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
        />
        {state?.fieldErrors?.['description'] && (
          <p className="text-xs text-red-600 mt-1">{state.fieldErrors['description']}</p>
        )}
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
          >
            <option value="LOW">Niedrig</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">Hoch</option>
            <option value="URGENT">Dringend</option>
          </select>
        </div>

        <div>
          <label className="label" htmlFor="dueAt">
            Fällig am
          </label>
          <input
            id="dueAt"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="input"
            disabled={disabled || isPending}
          />
        </div>
      </div>

      <div>
        <label className="label">Formular mitschicken (optional)</label>
        <select
          value={formTemplateId}
          onChange={(e) => setFormTemplateId(e.target.value)}
          className="input"
          disabled={disabled || isPending}
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
      </div>

      {state?.error && (
        <div role="alert" className="alert-error-sm">
          {state.error}
        </div>
      )}

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
