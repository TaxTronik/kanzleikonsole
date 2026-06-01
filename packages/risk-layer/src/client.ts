// =============================================================================
// RiskLayerClient — typisierter HTTP-Client um die §4-Engine.
//
// Reiner Transport: Bearer-Auth, Timeout pro Call, Circuit-Breaker + Retry,
// Schema-Validierung, Domänen-Mapping. KEINE Geschäftslogik (kein DB-/Request-
// Zugriff — das passiert app-seitig in apps/web/src/server/risk).
//
// `safeFetch` (@taxtronik/http-utils) erzwingt den SSRF-Guard; der interne
// Engine-Host MUSS daher in INTERNAL_FETCH_HOSTS stehen (sonst löst er auf eine
// private Adresse auf und wird geblockt — Absicht).
// =============================================================================

import { safeFetch } from '@taxtronik/http-utils';
import { requireRiskLayerConfig, type RiskLayerConfig } from './config';
import { mapAnalyse, type RiskAnalysisResult } from './mapping';
import {
  AnalyseResponseSchema,
  HealthResponseSchema,
  KatalogDefiniereResponseSchema,
  KatalogResponseSchema,
  OpaqueObjectSchema,
  type HealthResponse,
  type KatalogDefiniereResponse,
  type KatalogResponse,
  type OpaqueObject,
} from './schema';
import {
  CircuitBreaker,
  CircuitOpenError,
  executeResilient,
  type RetryOptions,
} from './resilience';

// Timeouts: schnell (deterministisch) vs. LLM-Pfad (15–30 s + Puffer).
const FAST_TIMEOUT_MS = 10_000;
const LLM_TIMEOUT_MS = 45_000;

// Retry-Profile: idempotente/billige Calls dürfen wiederholen; teure (LLM) und
// schreibende (definiere) NICHT.
const FAST_RETRY: RetryOptions = { retries: 2, baseDelayMs: 300 };
const NO_RETRY: RetryOptions = { retries: 0, baseDelayMs: 0 };

const BREAKER_DEFAULTS = { failureThreshold: 5, resetTimeoutMs: 30_000 };

export interface ZweiphasenAnalyseInput {
  text: string;
  /** false (Default) = schnell/deterministisch; true = LLM-Schicht (langsam). */
  mitLLM?: boolean;
  optionen?: Record<string, unknown>;
}

/** HTTP-Fehler der Engine (non-2xx). Trägt den Status für Retry-Entscheidungen. */
export class RiskLayerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Risk-Layer ${path} antwortete ${status}: ${body.slice(0, 200)}`);
    this.name = 'RiskLayerHttpError';
  }
}

/** 5xx/429 und Transport-/Timeout-Fehler sind transient → retrybar. 4xx nicht. */
function isRetryable(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof RiskLayerHttpError) return err.status >= 500 || err.status === 429;
  // Transportfehler (DNS/Connect/Reset) oder Timeout (AbortError).
  return true;
}

export interface RiskLayerClientOptions {
  /** Override der Config (Tests/Mehrmandanten); Default: aus @taxtronik/config. */
  config?: RiskLayerConfig;
  /** Override des fetch (Tests); Default: safeFetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Geteilter Breaker (Tests/DI); Default: neuer pro Client. */
  breaker?: CircuitBreaker;
}

export class RiskLayerClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly breaker: CircuitBreaker;

  constructor(opts: RiskLayerClientOptions = {}) {
    const cfg = opts.config ?? requireRiskLayerConfig();
    this.url = cfg.url.replace(/\/$/, '');
    this.token = cfg.token;
    this.fetchImpl = opts.fetchImpl ?? safeFetch;
    this.breaker = opts.breaker ?? new CircuitBreaker(BREAKER_DEFAULTS);
  }

  // --- Analyse (Zwei-Phasen) ------------------------------------------------

  /**
   * `POST /v1/analyse`. `mitLLM:false` (Default) = schnell/deterministisch und
   * retrybar; `mitLLM:true` = LLM-Schicht, langer Timeout, KEIN Auto-Retry.
   */
  async analyse(input: ZweiphasenAnalyseInput): Promise<RiskAnalysisResult> {
    const mitLLM = input.mitLLM ?? false;
    const raw = await this.request('POST', '/v1/analyse', {
      body: { text: input.text, mitLLM, optionen: input.optionen ?? {} },
      timeoutMs: mitLLM ? LLM_TIMEOUT_MS : FAST_TIMEOUT_MS,
      retry: mitLLM ? NO_RETRY : FAST_RETRY,
    });
    // Vollständige Validierung + Mapping (mapAnalyse parst das Envelope selbst).
    AnalyseResponseSchema.parse(raw);
    return mapAnalyse(raw);
  }

  // --- Katalog --------------------------------------------------------------

  /** `GET /v1/katalog` — Katalog lesen (Version + Begriffe). */
  async katalogGet(): Promise<KatalogResponse> {
    const raw = await this.request('GET', '/v1/katalog', { retry: FAST_RETRY });
    return KatalogResponseSchema.parse(raw);
  }

  /** `POST /v1/katalog/definiere` — Berater-Begriff anlegen (kein Auto-Retry: Schreiben). */
  async katalogDefiniere(input: {
    begriff: string;
    definition: string;
    normAnker?: string[];
    scope?: string;
  }): Promise<KatalogDefiniereResponse> {
    const raw = await this.request('POST', '/v1/katalog/definiere', {
      body: input,
      retry: NO_RETRY,
    });
    return KatalogDefiniereResponseSchema.parse(raw);
  }

  // --- Normgraph (Cross-Reference) ------------------------------------------

  /** `GET /v1/normgraph/aufloesen?id=` — Norm-Kaskade auflösen. */
  async normgraphAufloesen(id: string): Promise<OpaqueObject> {
    const raw = await this.request('GET', '/v1/normgraph/aufloesen', {
      query: { id },
      retry: FAST_RETRY,
    });
    return OpaqueObjectSchema.parse(raw);
  }

  /** `GET /v1/normgraph/suche?q=` — Cross-Reference-Suche. */
  async normgraphSuche(q: string): Promise<OpaqueObject> {
    const raw = await this.request('GET', '/v1/normgraph/suche', {
      query: { q },
      retry: FAST_RETRY,
    });
    return OpaqueObjectSchema.parse(raw);
  }

  // --- Embedding ------------------------------------------------------------

  /** `POST /v1/embedding/suche` — semantische Norm-Vorschläge zu Freitext. */
  async embeddingSuche(text: string): Promise<OpaqueObject> {
    const raw = await this.request('POST', '/v1/embedding/suche', {
      body: { text },
      retry: FAST_RETRY,
    });
    return OpaqueObjectSchema.parse(raw);
  }

  // --- Health ---------------------------------------------------------------

  /** `GET /v1/health`. */
  async health(): Promise<HealthResponse> {
    const raw = await this.request('GET', '/v1/health', { retry: NO_RETRY });
    return HealthResponseSchema.parse(raw);
  }

  // --- intern ---------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string>;
      timeoutMs?: number;
      retry: RetryOptions;
    },
  ): Promise<unknown> {
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const url = `${this.url}${path}${qs}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    return executeResilient(this.breaker, opts.retry, isRetryable, async () => {
      // Eigener Timeout pro Call (safeFetch akzeptiert das signal und überschreibt
      // seinen 30s-Default damit).
      init.signal = AbortSignal.timeout(opts.timeoutMs ?? FAST_TIMEOUT_MS);
      const res = await this.fetchImpl(url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new RiskLayerHttpError(res.status, path, text);
      }
      return res.json();
    });
  }
}
