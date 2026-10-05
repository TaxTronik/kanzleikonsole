// =============================================================================
// Reine Logik der ClientCombobox: Tastaturnavigation, Antwortprüfung und
// Statustexte. Ohne React/DOM, damit sie direkt testbar ist.
// =============================================================================

import type { ClientPickerOption, ClientPickerResult } from '@/lib/client-picker';

/** Vorauswahl/Wert: mindestens ID und Anzeigename. */
export type ClientComboboxValue = Pick<ClientPickerOption, 'id' | 'name'> &
  Partial<Omit<ClientPickerOption, 'id' | 'name'>>;

/**
 * Umgang mit Mandanten ohne GwG-Freigabe, sofern der Filter sie liefert:
 * `selectable` wählbar, `disabled` sichtbar aber nicht wählbar.
 */
export type ClientComboboxInactiveMode = 'selectable' | 'disabled';

export const CLIENT_COMBOBOX_DEBOUNCE_MS = 250;

export function isClientOptionSelectable(
  option: ClientPickerOption,
  inactive: ClientComboboxInactiveMode,
): boolean {
  return option.allowActive || inactive === 'selectable';
}

export function clientOptionDetail(option: ClientComboboxValue): string {
  return [
    option.datevNo ? `DATEV ${option.datevNo}` : null,
    option.addisonNo ? `Addison ${option.addisonNo}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type ComboboxKeyAction =
  | { type: 'none' }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'move'; index: number }
  | { type: 'select'; index: number };

const NONE: ComboboxKeyAction = { type: 'none' };

function moveTarget(key: string, active: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return active < 0 ? 0 : Math.min(active + 1, count - 1);
    case 'ArrowUp':
      return active < 0 ? count - 1 : Math.max(active - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * ARIA-Combobox-Tastaturmodell (WAI-ARIA APG, Listbox-Popup):
 *  - Pfeil ab/auf öffnet die Liste bzw. bewegt die aktive Option,
 *  - Pos1/Ende springen innerhalb der geöffneten Liste,
 *  - Enter wählt die aktive, auswählbare Option,
 *  - Escape schließt die geöffnete Liste, Tab schließt ohne Auswahl.
 */
export function comboboxKeyAction(
  key: string,
  state: { open: boolean; active: number; selectable: readonly boolean[] },
): ComboboxKeyAction {
  const { open, active, selectable } = state;
  if (!open) {
    return key === 'ArrowDown' || key === 'ArrowUp' ? { type: 'open' } : NONE;
  }
  if (key === 'Escape' || key === 'Tab') return { type: 'close' };
  if (key === 'Enter') {
    return active >= 0 && selectable[active] ? { type: 'select', index: active } : NONE;
  }
  const target = moveTarget(key, active, selectable.length);
  return target === null ? NONE : { type: 'move', index: target };
}

export interface ComboboxKeyEvent {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface ComboboxKeyEffects {
  open(): void;
  close(): void;
  move(index: number): void;
  choose(index: number): void;
}

/**
 * Setzt eine Taste in Wirkungen um. Escape bei geöffneter Liste stoppt die
 * Weitergabe, damit ein umgebender Dialog offen bleibt; Tab schließt ohne
 * den Fokuswechsel zu verhindern. Hilfsauswahlen (`blockEnterSubmit`)
 * senden mit Enter nie das umgebende Formular ab.
 */
export function handleComboboxKeyDown(
  event: ComboboxKeyEvent,
  state: { open: boolean; active: number; selectable: readonly boolean[] },
  effects: ComboboxKeyEffects,
  blockEnterSubmit = false,
): void {
  const action = comboboxKeyAction(event.key, state);
  if (action.type === 'none') {
    if (event.key === 'Enter' && blockEnterSubmit) event.preventDefault();
    return;
  }
  if (action.type === 'close') {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
    }
    effects.close();
    return;
  }
  event.preventDefault();
  if (action.type === 'open') effects.open();
  else if (action.type === 'move') effects.move(action.index);
  else effects.choose(action.index);
}

export class ClientPickerFetchError extends Error {}

function isOption(value: unknown): value is ClientPickerOption {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.datevNo === null || typeof v.datevNo === 'string') &&
    (v.addisonNo === null || typeof v.addisonNo === 'string') &&
    typeof v.allowActive === 'boolean' &&
    typeof v.mandateEnded === 'boolean'
  );
}

/** Prüft die Antwortform, statt fremde JSON-Felder ungeprüft zu rendern. */
export function parseClientPickerResult(value: unknown): ClientPickerResult {
  const v = (value ?? {}) as Record<string, unknown>;
  if (!Array.isArray(v.clients) || !v.clients.every(isOption)) {
    throw new ClientPickerFetchError('Mandantensuche lieferte eine ungültige Antwort.');
  }
  return {
    clients: v.clients,
    limited: v.limited === true,
    mode: v.mode === 'assigned' ? 'assigned' : 'search',
  };
}

export async function fetchClientPickerResult(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientPickerResult> {
  const response = await fetchImpl(url, {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (response.status === 429) {
    throw new ClientPickerFetchError('Zu viele Suchanfragen. Bitte kurz warten.');
  }
  if (!response.ok) {
    throw new ClientPickerFetchError('Mandantensuche fehlgeschlagen. Bitte erneut versuchen.');
  }
  return parseClientPickerResult(await response.json());
}

export function clientPickerErrorMessage(error: unknown): string {
  return error instanceof ClientPickerFetchError
    ? error.message
    : 'Mandantensuche nicht erreichbar. Bitte Verbindung prüfen.';
}

function resultMessage(result: ClientPickerResult): string {
  const count = result.clients.length;
  if (result.mode === 'assigned') {
    return count === 0
      ? 'Keine zugeordneten Mandanten. Bitte Name, DATEV- oder Addison-Nr. eingeben.'
      : `${count} zugeordnete Mandanten.`;
  }
  if (count === 0) return 'Kein zugänglicher Mandant gefunden.';
  const found = count === 1 ? '1 Mandant gefunden.' : `${count} Mandanten gefunden.`;
  return result.limited ? `${found} Weitere Treffer – Suchbegriff bitte genauer eingeben.` : found;
}

/** Text für die Live-Region; leer, solange die Liste geschlossen ist. */
export function clientComboboxStatus(state: {
  open: boolean;
  loading: boolean;
  error: string | null;
  result: ClientPickerResult | null;
}): string {
  if (!state.open) return '';
  if (state.loading) return 'Mandanten werden gesucht.';
  if (state.error) return state.error;
  return state.result ? resultMessage(state.result) : '';
}

/**
 * Formularvalidierung: getippter Text ohne ausgewählten Mandanten blockiert
 * das Absenden immer (sonst ginge still „kein Mandant" an den Server);
 * Pflichtfelder verlangen zusätzlich eine Auswahl.
 */
export function clientComboboxValidity(state: {
  required: boolean;
  selected: ClientComboboxValue | null;
  query: string;
}): string {
  if (state.selected) return '';
  if (state.query.trim()) return 'Bitte einen Mandanten aus der Liste auswählen.';
  return state.required ? 'Bitte einen Mandanten auswählen.' : '';
}
