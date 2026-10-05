'use client';

// =============================================================================
// ClientCombobox — Mandantenauswahl mit Serversuche (WAI-ARIA-Combobox)
//
// Ersetzt <select>-Listen, die den gesamten Bestand (oder alphabetisch die
// ersten 500 Mandanten) in die Seite geladen haben. Die Suche läuft über
// GET /api/staff/clients/search mit derselben Sichtbarkeitsregel wie alle
// Mandantenlisten; `filters` verengt nur (z. B. nur GwG-freigegebene).
//
// Formularvertrag: Mit `name` schreibt die Komponente die gewählte ID in ein
// verstecktes Feld gleichen Namens — bestehende <form>-Actions bleiben
// unverändert. `defaultValue` (unkontrolliert) bzw. `value`/`onChange`
// (kontrolliert) setzen eine Vorauswahl aus ID und Anzeigenamen.
// =============================================================================

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import {
  canonicalClientPickerFilters,
  clientPickerUrl,
  type ClientPickerFilter,
  type ClientPickerOption,
  type ClientPickerResult,
} from '@/lib/client-picker';
import { revealPanelOption } from './anchored-panel';
import {
  CLIENT_COMBOBOX_DEBOUNCE_MS,
  clientComboboxStatus,
  clientComboboxValidity,
  clientOptionDetail,
  clientPickerErrorMessage,
  fetchClientPickerResult,
  handleComboboxKeyDown,
  isClientOptionSelectable,
  type ClientComboboxInactiveMode,
  type ClientComboboxValue,
} from './client-combobox-model';

export type { ClientComboboxInactiveMode, ClientComboboxValue } from './client-combobox-model';

export interface ClientComboboxProps {
  /** Name des versteckten Formularfelds mit der Mandanten-ID (leer = keine Auswahl). */
  name?: string;
  /** ID des sichtbaren Eingabefelds (für `<label htmlFor>`). */
  id?: string;
  /** Zugänglicher Name, falls kein sichtbares Label verknüpft ist. */
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
  /** Verengende Lebenszyklusfilter; die Zugriffsregel gilt immer. */
  filters?: readonly ClientPickerFilter[];
  /** Nicht freigegebene Mandanten wählbar oder nur sichtbar. */
  inactive?: ClientComboboxInactiveMode;
  /** Unkontrollierte Vorauswahl. */
  defaultValue?: ClientComboboxValue | null;
  /** Kontrollierter Wert (`null` = keine Auswahl). */
  value?: ClientComboboxValue | null;
  onChange?: (client: ClientComboboxValue | null) => void;
  /** Bereits anderweitig gewählte Mandanten nicht erneut anbieten. */
  excludeIds?: readonly string[];
  /**
   * Hilfsauswahl innerhalb eines größeren Formulars (z. B. „Mandant
   * verknüpfen"): Enter sendet das umgebende Formular nicht ab.
   */
  blockEnterSubmit?: boolean;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputClassName?: string;
}

interface SearchSnapshot {
  url: string;
  result: ClientPickerResult | null;
  error: string | null;
}

function toValue(option: ClientPickerOption): ClientComboboxValue {
  return { ...option };
}

/** Auswahl + sichtbarer Text; kontrolliert oder unkontrolliert. */
function useSelection(props: ClientComboboxProps) {
  const controlled = props.value !== undefined;
  const [internal, setInternal] = useState<ClientComboboxValue | null>(props.defaultValue ?? null);
  const selected = controlled ? (props.value ?? null) : internal;
  const selectedId = selected?.id ?? null;
  const [query, setQuery] = useState(selected?.name ?? '');
  const [shownId, setShownId] = useState<string | null>(selectedId);
  // Eine von außen geänderte Auswahl (z. B. bekannter Anrufer) zeigt ihren Namen.
  if (selectedId !== shownId) {
    setShownId(selectedId);
    setQuery(selected?.name ?? '');
  }

  function commit(next: ClientComboboxValue | null) {
    setShownId(next?.id ?? null);
    setQuery(next?.name ?? '');
    if (!controlled) setInternal(next);
    props.onChange?.(next);
  }

  function edit(text: string) {
    setQuery(text);
    // Treffer gehören exakt zum sichtbaren Text: Tippen hebt eine Auswahl auf,
    // damit nie still der zuvor gewählte Mandant abgeschickt wird.
    if (!selected) return;
    setShownId(null);
    if (!controlled) setInternal(null);
    props.onChange?.(null);
  }

  return { selected, query, commit, edit };
}

/** Debounce + Abbruch: nur die Antwort zur aktuellen URL wird angezeigt. */
function useClientSearch(requestUrl: string | null, debounce: boolean) {
  const [snapshot, setSnapshot] = useState<SearchSnapshot | null>(null);

  useEffect(() => {
    if (!requestUrl) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        fetchClientPickerResult(requestUrl, controller.signal).then(
          (result) => {
            if (!controller.signal.aborted) setSnapshot({ url: requestUrl, result, error: null });
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            setSnapshot({ url: requestUrl, result: null, error: clientPickerErrorMessage(error) });
          },
        );
      },
      debounce ? CLIENT_COMBOBOX_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [requestUrl, debounce]);

  const current = snapshot && snapshot.url === requestUrl ? snapshot : null;
  return {
    loading: requestUrl !== null && current === null,
    result: current?.result ?? null,
    error: current?.error ?? null,
  };
}

// Refs werden nur in Effekten und Event-Handlern gelesen und deshalb getrennt
// vom Render-Zustand übergeben (React-Compiler-Regel react-hooks/refs).
function useClientCombobox(
  props: ClientComboboxProps,
  inputRef: RefObject<HTMLInputElement | null>,
  listRef: RefObject<HTMLDivElement | null>,
) {
  const generatedId = useId();
  const inputId = props.id ?? `${generatedId}-input`;
  const listboxId = `${generatedId}-listbox`;
  const statusId = `${generatedId}-status`;
  const inactive = props.inactive ?? 'selectable';
  const { selected, query, commit, edit } = useSelection(props);
  const [open, setOpen] = useState(false);
  const filtersKey = canonicalClientPickerFilters(props.filters ?? []).join(',');
  const term = selected ? '' : query.trim();
  const requestUrl =
    open && !props.disabled
      ? clientPickerUrl({
          query: term,
          filters: (filtersKey ? filtersKey.split(',') : []) as ClientPickerFilter[],
        })
      : null;
  const search = useClientSearch(requestUrl, term !== '');
  const excluded = new Set(props.excludeIds ?? []);
  const options = (search.result?.clients ?? []).filter((option) => !excluded.has(option.id));
  const [activeState, setActiveState] = useState({ url: null as string | null, index: -1 });
  const active =
    activeState.url === requestUrl && activeState.index < options.length ? activeState.index : -1;
  const activeOptionId = open && active >= 0 ? `${listboxId}-option-${active}` : undefined;
  const validity = clientComboboxValidity({ required: !!props.required, selected, query });

  useEffect(() => {
    inputRef.current?.setCustomValidity(validity);
  }, [inputRef, validity]);

  useEffect(() => {
    const panel = listRef.current;
    const option = panel?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (panel && option) revealPanelOption(panel, option);
  }, [listRef, activeOptionId]);

  function choose(option: ClientPickerOption) {
    if (!isClientOptionSelectable(option, inactive)) return;
    commit(toValue(option));
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    handleComboboxKeyDown(
      event,
      {
        open,
        active,
        selectable: options.map((option) => isClientOptionSelectable(option, inactive)),
      },
      {
        open: () => setOpen(true),
        close: () => setOpen(false),
        move: (index) => setActiveState({ url: requestUrl, index }),
        choose: (index) => choose(options[index]!),
      },
      props.blockEnterSubmit,
    );
  }

  return {
    props,
    inputId,
    listboxId,
    statusId,
    inactive,
    selected,
    query,
    open,
    active,
    activeOptionId,
    options,
    loading: search.loading,
    result: search.result,
    error: search.error,
    status: clientComboboxStatus({
      open,
      loading: search.loading,
      error: search.error,
      result: search.result,
    }),
    setOpen,
    setActive: (index: number) => setActiveState({ url: requestUrl, index }),
    edit,
    clear: () => commit(null),
    choose,
    onKeyDown,
  };
}

type ComboboxState = ReturnType<typeof useClientCombobox>;

function ComboboxInput({
  c,
  inputRef,
}: {
  c: ComboboxState;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { props } = c;
  const describedBy = [c.statusId, props['aria-describedby']].filter(Boolean).join(' ');
  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={c.inputId}
        type="text"
        role="combobox"
        aria-label={props['aria-label']}
        aria-autocomplete="list"
        aria-expanded={c.open}
        aria-controls={c.open ? c.listboxId : undefined}
        aria-activedescendant={c.activeOptionId}
        aria-invalid={props['aria-invalid']}
        aria-describedby={describedBy}
        value={c.query}
        onChange={(event) => {
          c.edit(event.target.value);
          c.setOpen(true);
        }}
        onFocus={() => {
          if (!c.selected) c.setOpen(true);
        }}
        onBlur={() => c.setOpen(false)}
        onKeyDown={c.onKeyDown}
        className={props.inputClassName ?? 'input pr-9'}
        placeholder={props.placeholder ?? 'Name, DATEV- oder Addison-Nr.'}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        required={props.required}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
      />
      <ComboboxAdornment c={c} inputRef={inputRef} />
    </div>
  );
}

function ComboboxAdornment({
  c,
  inputRef,
}: {
  c: ComboboxState;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  if (c.loading) {
    return (
      <LoaderCircle
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted"
        aria-hidden="true"
      />
    );
  }
  if (!c.selected || c.props.disabled) return null;
  return (
    <button
      type="button"
      onClick={() => {
        c.clear();
        inputRef.current?.focus();
      }}
      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-primary"
      aria-label={`Auswahl ${c.selected.name} entfernen`}
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function OptionBadges({ option }: { option: ClientPickerOption }) {
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      {!option.allowActive && <span className="badge-yellow">GwG ausstehend</span>}
      {option.mandateEnded && <span className="badge-gray">Mandat beendet</span>}
    </span>
  );
}

function ComboboxOption({
  c,
  option,
  index,
}: {
  c: ComboboxState;
  option: ClientPickerOption;
  index: number;
}) {
  const detail = clientOptionDetail(option);
  const selectable = isClientOptionSelectable(option, c.inactive);
  const isActive = index === c.active;
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-primary">{option.name}</span>
        {detail && <span className="block truncate text-xs text-muted">{detail}</span>}
        {!selectable && (
          <span className="block text-xs text-amber-700 dark:text-amber-300">
            Noch nicht auswählbar: GwG-Prüfung ausstehend
          </span>
        )}
      </span>
      <OptionBadges option={option} />
    </>
  );
  const base = 'flex w-full items-center justify-between gap-3 px-3 py-2 text-left';
  if (!selectable) {
    return (
      <li role="presentation">
        <div
          id={`${c.listboxId}-option-${index}`}
          role="option"
          aria-selected={isActive}
          aria-disabled="true"
          className={`${base} ${isActive ? 'bg-amber-100/70 dark:bg-amber-900/30' : 'bg-amber-50/60 dark:bg-amber-900/10'}`}
        >
          {body}
        </div>
      </li>
    );
  }
  return (
    <li role="presentation">
      <button
        id={`${c.listboxId}-option-${index}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={isActive}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => c.setActive(index)}
        onClick={() => c.choose(option)}
        className={`${base} ${isActive ? 'bg-brand-50 dark:bg-brand-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}
      >
        {body}
      </button>
    </li>
  );
}

function ComboboxHint({ c }: { c: ComboboxState }) {
  if (c.loading) return null;
  if (c.error) return <p className="px-3 py-2 text-xs text-red-700 dark:text-red-400">{c.error}</p>;
  if (!c.result || (c.result.clients.length > 0 && !c.result.limited)) return null;
  return <p className="px-3 py-2 text-xs text-muted">{c.status}</p>;
}

function ComboboxPanel({
  c,
  listRef,
}: {
  c: ComboboxState;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const assigned = c.result?.mode === 'assigned' && c.options.length > 0;
  return (
    <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border border-default bg-surface shadow-lg">
      {assigned && <p className="px-3 pt-2 text-xs text-muted">Ihre zugeordneten Mandanten</p>}
      <div
        ref={listRef}
        id={c.listboxId}
        role="listbox"
        aria-label="Mandantenvorschläge"
        aria-busy={c.loading}
        className="max-h-64 overflow-y-auto overscroll-contain"
      >
        <ul role="presentation" className="divide-y divide-border-subtle">
          {c.options.map((option, index) => (
            <ComboboxOption key={option.id} c={c} option={option} index={index} />
          ))}
        </ul>
      </div>
      <ComboboxHint c={c} />
    </div>
  );
}

export function ClientCombobox(props: ClientComboboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const c = useClientCombobox(props, inputRef, listRef);
  return (
    <div className="relative">
      {props.name !== undefined && (
        <input
          type="hidden"
          name={props.name}
          value={c.selected?.id ?? ''}
          disabled={props.disabled}
        />
      )}
      <ComboboxInput c={c} inputRef={inputRef} />
      {c.open && <ComboboxPanel c={c} listRef={listRef} />}
      <p id={c.statusId} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {c.status}
      </p>
    </div>
  );
}
