// =============================================================================
// ElsterBridgeClient — typisierter HTTP-Client um die eric-bridge.
//
// Reiner Transport: Bearer-Auth, Timeout pro Call, Schema-Validierung.
// KEINE Geschäftslogik (kein DB-/Request-Zugriff — Persistenz, Audit-Events
// und PIN-Eingabe passieren app-/worker-seitig).
//
// Der Default-Transport ist ein enger, trusted Backend-Fetch (Muster
// Risk-Layer): ELSTER_BRIDGE_URL kommt aus Operator-ENV, die Pfade sind fest
// codiert, die Bridge hängt im internen Compose-Netz. Kein Circuit-Breaker:
// die Bridge ist ein einzelner lokaler Container, und die authentifizierten
// Abfragen sollen NIE automatisch wiederholt werden (jeder Aufruf erzeugt
// einen Vorgang beim ELSTER-Server).
//
// Die PIN des Portalzertifikats wird pro Aufruf durchgereicht und hier weder
// gespeichert noch geloggt.
// =============================================================================

import { requireElsterConfig, type ElsterConfig } from './config';
import {
  AbfrageResponseSchema,
  BridgeHealthSchema,
  KontoabfrageResponseSchema,
  ValidateResponseSchema,
  type AbfrageResponse,
  type BridgeHealth,
  type KontoabfrageResponse,
  type KontoabfrageTeil,
  type ValidateResponse,
} from './schema';

// Validierung ist lokal/CPU-gebunden (kein Serverkontakt) — trotzdem großzügig:
// der erste Aufruf einer Datenart lädt das Prüf-Plugin nach.
const VALIDATE_TIMEOUT_MS = 30_000;
// Authentifizierte Abfragen laufen über den ELSTER-Server (Roundtrip + Krypto).
const ABFRAGE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;

/** HTTP-Fehler der Bridge (non-2xx). Trägt Status + Fehler-Body für den Aufrufer. */
export class ElsterBridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`eric-bridge ${path} antwortete ${status}: ${body.slice(0, 200)}`);
    this.name = 'ElsterBridgeHttpError';
  }
}

async function trustedBridgeFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Bridge-URL muss http(s) sein (war: ${parsed.protocol}).`);
  }
  return fetch(parsed.toString(), {
    ...init,
    redirect: 'error',
  });
}

/** Übertragungsmodus: Testbetrieb (Clearingstelle verwirft nach Validierung)
 *  oder EXPLIZIT erklärter Echtfall. Die Bridge lehnt Aufrufe ohne diese
 *  Entscheidung ab — versehentliche Echtübermittlungen sind so ausgeschlossen. */
export type Uebertragung = { testmerker: string } | { echtfall: true };

export interface KontoabfrageInput {
  /** Teil-Abfragen (max. 75, alle Steuernummern desselben Finanzamts). */
  abfragen: KontoabfrageTeil[];
  /** <DatenLieferant> des TransferHeaders — die Kanzlei. */
  datenLieferant: string;
  /** PIN des Portalzertifikats — pro Vorgang, wird nicht persistiert. */
  pin: string;
  uebertragung: Uebertragung;
}

export interface ElsterBridgeClientOptions {
  /** Override der Config (Tests); Default: aus @taxtronik/config. */
  config?: ElsterConfig;
  /** Override des fetch (Tests); Default: trustedBridgeFetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class ElsterBridgeClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(opts: ElsterBridgeClientOptions = {}) {
    const cfg = opts.config ?? requireElsterConfig();
    this.url = cfg.url.replace(/\/$/, '');
    this.token = cfg.token;
    this.fetchImpl = opts.fetchImpl ?? trustedBridgeFetch;
  }

  /** `GET /healthz` — Bridge erreichbar, ERiC geladen, Zertifikat/Hersteller-ID gesetzt? */
  async health(): Promise<BridgeHealth> {
    const raw = await this.request('GET', '/healthz', { timeoutMs: HEALTH_TIMEOUT_MS, auth: false });
    return BridgeHealthSchema.parse(raw);
  }

  /**
   * `POST /v1/validate` — Stufe 1: Datensatz lokal gegen das Prüf-Plugin der
   * Datenart validieren (kein Serverkontakt, kein Zertifikat).
   */
  async validate(input: { xml: string; datenartVersion: string }): Promise<ValidateResponse> {
    const raw = await this.request('POST', '/v1/validate', {
      body: input,
      timeoutMs: VALIDATE_TIMEOUT_MS,
    });
    return ValidateResponseSchema.parse(raw);
  }

  /**
   * `POST /v1/kontoabfrage` — Stufe 2: Kontoabfrage (Istbuchungen, offene
   * Beträge, Sollstellungen) aus strukturierten Parametern. Datenteil und
   * TransferHeader (inkl. Hersteller-ID) entstehen in der Bridge.
   */
  async kontoabfrage(input: KontoabfrageInput): Promise<KontoabfrageResponse> {
    const raw = await this.request('POST', '/v1/kontoabfrage', {
      body: {
        abfragen: input.abfragen,
        datenLieferant: input.datenLieferant,
        pin: input.pin,
        ...input.uebertragung,
      },
      timeoutMs: ABFRAGE_TIMEOUT_MS,
    });
    return KontoabfrageResponseSchema.parse(raw);
  }

  /**
   * `POST /v1/abfrage` — Stufe 2, generisch: beliebige Datenart mit
   * selbst gebautem Datenteil (OHNE Namespaces an <DatenTeil>/<Elster>,
   * OHNE TransferHeader — beides ergänzt die Bridge). Für künftige
   * Datenarten, bis sie einen eigenen Komfort-Endpunkt bekommen.
   */
  async abfrage(input: {
    datenteil: string;
    datenartVersion: string;
    verfahren: string;
    datenart: string;
    vorgang: string;
    datenLieferant: string;
    pin: string;
    uebertragung: Uebertragung;
  }): Promise<AbfrageResponse> {
    const { uebertragung, ...rest } = input;
    const raw = await this.request('POST', '/v1/abfrage', {
      body: { ...rest, ...uebertragung },
      timeoutMs: ABFRAGE_TIMEOUT_MS,
    });
    return AbfrageResponseSchema.parse(raw);
  }

  // --- intern ---------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; timeoutMs: number; auth?: boolean },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.auth !== false) headers.authorization = `Bearer ${this.token}`;
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs),
    };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(`${this.url}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ElsterBridgeHttpError(res.status, path, text);
    }
    return res.json();
  }
}
