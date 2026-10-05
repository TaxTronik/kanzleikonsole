// =============================================================================
// Mandantenauswahl: gemeinsamer Vertrag zwischen der ClientCombobox (Browser)
// und GET /api/staff/clients/search (Server).
//
// Reines Datenmodul ohne Server-Importe, damit Komponente, Route und Tests
// dieselbe Parameter- und Antwortform verwenden. Die Zugriffsregel selbst
// (OPEN/RESTRICTED/vertraulich) entscheidet ausschließlich der Server.
// =============================================================================

export const CLIENT_PICKER_ENDPOINT = '/api/staff/clients/search';

/** Serverseitige Obergrenze je Antwort; ein weiterer Treffer setzt `limited`. */
export const CLIENT_PICKER_LIMIT = 20;

export const CLIENT_PICKER_QUERY_MAX_LENGTH = 100;

/**
 * Verengende Lebenszyklusfilter einer Auswahl. Sie gelten zusätzlich zur
 * Zugriffsregel und können sie nie erweitern:
 *  - `active`: nur Mandanten mit GwG-Freigabe (`allowActive`)
 *  - `notEnded`: kein Mandatsende gesetzt
 *  - `notAnonymized`: nicht anonymisiert
 *  - `activeWorkflow`: mindestens ein laufender Workflow
 */
export const CLIENT_PICKER_FILTERS = [
  'active',
  'notEnded',
  'notAnonymized',
  'activeWorkflow',
] as const;

export type ClientPickerFilter = (typeof CLIENT_PICKER_FILTERS)[number];

export interface ClientPickerOption {
  id: string;
  name: string;
  datevNo: string | null;
  addisonNo: string | null;
  /** GwG-Freigabe des Mandanten. */
  allowActive: boolean;
  /** Mandatsende ist gesetzt. */
  mandateEnded: boolean;
}

export interface ClientPickerRequest {
  query: string;
  filters: readonly ClientPickerFilter[];
}

export interface ClientPickerResult {
  clients: ClientPickerOption[];
  /** Es gibt mehr Treffer als die Obergrenze. */
  limited: boolean;
  /** `search`: Treffer zum Suchbegriff; `assigned`: eigene Zuordnungen ohne Suchbegriff. */
  mode: 'search' | 'assigned';
}

const FILTER_SET: ReadonlySet<string> = new Set(CLIENT_PICKER_FILTERS);

function isClientPickerFilter(value: string): value is ClientPickerFilter {
  return FILTER_SET.has(value);
}

/** Dedupliziert und sortiert, damit gleiche Auswahlregeln gleiche URLs ergeben. */
export function canonicalClientPickerFilters(
  filters: readonly ClientPickerFilter[],
): ClientPickerFilter[] {
  return CLIENT_PICKER_FILTERS.filter((filter) => filters.includes(filter));
}

/**
 * Liest `q` und `filter` einer Such-URL. Unbekannte Filter oder überlange
 * Suchbegriffe ergeben `null` (fail-closed statt still ignorierter Regel).
 */
export function parseClientPickerRequest(params: URLSearchParams): ClientPickerRequest | null {
  const query = (params.get('q') ?? '').trim();
  if (query.length > CLIENT_PICKER_QUERY_MAX_LENGTH) return null;
  const tokens = (params.get('filter') ?? '').split(',').filter(Boolean);
  if (!tokens.every(isClientPickerFilter)) return null;
  return { query, filters: canonicalClientPickerFilters(tokens) };
}

export function clientPickerUrl(request: ClientPickerRequest): string {
  const params = new URLSearchParams();
  const query = request.query.trim();
  if (query) params.set('q', query);
  const filters = canonicalClientPickerFilters(request.filters);
  if (filters.length > 0) params.set('filter', filters.join(','));
  const search = params.toString();
  return search ? `${CLIENT_PICKER_ENDPOINT}?${search}` : CLIENT_PICKER_ENDPOINT;
}
