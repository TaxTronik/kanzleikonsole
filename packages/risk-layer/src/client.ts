// =============================================================================
// RiskLayerClient — typisierter HTTP-Client um die §4-Engine.
//
// Reiner Transport: Bearer-Auth, Timeout pro Call, Circuit-Breaker + Retry,
// Schema-Validierung, Domänen-Mapping. KEINE Geschäftslogik (kein DB-/Request-
// Zugriff — das passiert app-seitig in apps/web/src/server/risk).
//
// Der Default-Transport ist bewusst ein enger, trusted Backend-Fetch:
// RISK_LAYER_URL kommt aus Operator-ENV, die Pfade sind fest codiert, und die
// Engine ist ein internes Backend (häufig 127.0.0.1, Docker-Service-DNS oder
// private LAN-IP). Der globale SSRF-Guard bleibt für admin-/nutzerkonfigurierbare
// URLs (RSS, TSA, n8n, Update-Manifest) zuständig.
// =============================================================================

import {
  requireRiskLayerConfig,
  RiskLayerOperatorNotConfiguredError,
  type RiskLayerConfig,
} from './config';
import { mapAnalyse, type RiskAnalysisResult } from './mapping';
import {
  HealthResponseSchema,
  EmbeddingCancelResponseSchema,
  EmbeddingRefreshResponseSchema,
  EmbeddingScheduleResponseSchema,
  EmbeddingStatusResponseSchema,
  KatalogDefiniereResponseSchema,
  KatalogKuratiereResponseSchema,
  KatalogKuratierungBegriffSchema,
  KatalogKuratierungListeSchema,
  KatalogResponseSchema,
  KatalogReviewResponseSchema,
  LlmStartResponseSchema,
  LlmStatusResponseSchema,
  LosErgebnisSchema,
  LosPruefenResponseSchema,
  OpaqueObjectSchema,
  RiskLayerErrorBodySchema,
  type HealthResponse,
  type EmbeddingCancelResponse,
  type EmbeddingRefreshResponse,
  type EmbeddingScheduleResponse,
  type EmbeddingStatusResponse,
  type KatalogDefiniereResponse,
  type KatalogKuratiereResponse,
  type KatalogKuratierungBegriff,
  type KatalogKuratierungListe,
  type KatalogResponse,
  type KatalogReviewResponse,
  type LlmStartResponse,
  type LlmStatusResponse,
  type LosBackend,
  type LosErgebnis,
  type LosNachweis,
  type LosPruefenResponse,
  type OpaqueObject,
} from './schema';
import {
  CircuitBreaker,
  CircuitOpenError,
  executeResilient,
  type RetryOptions,
} from './resilience';

// Timeouts: schnell (deterministisch) vs. LLM-Pfad. Letzterer läuft asynchron im
// Worker (kein synchroner Warter) → großzügig: ein großes Modell (z. B. 14B) kann
// auf einem langen Sachverhalt mehrere Minuten brauchen. 45 s war zu knapp.
const FAST_TIMEOUT_MS = 10_000;
const LLM_TIMEOUT_MS = 300_000;
// Los-Pfad: die QPU-Submission (IBM-Roundtrip) bzw. die Online-Attestierung beim
// Prüfen brauchen länger als der FAST-Pfad — bleiben aber deutlich unter LLM.
const LOS_TIMEOUT_MS = 60_000;

// Retry-Profile: idempotente/billige Calls dürfen wiederholen; teure (LLM) und
// schreibende (definiere) NICHT.
const FAST_RETRY: RetryOptions = { retries: 2, baseDelayMs: 300 };
const NO_RETRY: RetryOptions = { retries: 0, baseDelayMs: 0 };

const BREAKER_DEFAULTS = { failureThreshold: 5, resetTimeoutMs: 30_000 };

async function trustedRiskLayerFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Risk-Layer-URL muss http(s) sein (war: ${parsed.protocol}).`);
  }
  return fetch(parsed.toString(), {
    ...init,
    redirect: 'error',
  });
}

/** Review-Statuswerte des geteilten Festwissens (§4-Lebenszyklus, nur vorwärts). */
export type KatalogReviewStatus = 'entwurf' | 'geprüft' | 'freigegeben';

export interface ZweiphasenAnalyseInput {
  text: string;
  /** false (Default) = schnell/deterministisch; true = LLM-Schicht (langsam). */
  mitLLM?: boolean;
  optionen?: Record<string, unknown>;
  /** Berater-Kennung (StaffUser-ID) — damit personal-scoped Katalog-Kuratierung
   *  greift. Kein Mandantendatum; interner Host. */
  nutzer?: string;
}

/**
 * Extrahiert NUR strukturierte, unverfängliche Fehlerfelder aus dem Engine-Body
 * (§ 203: der analysierte Text ist ein Mandanten-Sachverhalt und darf NICHT über
 * eine Fehlermeldung in Logs/Monitoring landen). Gelingt das Parsen nicht oder
 * fehlt jedes bekannte Feld, wird `null` zurückgegeben → generische Meldung
 * ohne Roh-Body. Spiegelt `extractBridgeError` im ELSTER-Client.
 */
function extractRiskLayerError(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = RiskLayerErrorBodySchema.safeParse(json);
  if (!parsed.success) return null;
  const { error, detail, code } = parsed.data;
  const label = error ?? detail ?? null;
  if (label && code !== undefined) return `${label} (code ${code})`;
  if (label) return label;
  if (code !== undefined) return `code ${code}`;
  return null;
}

/** HTTP-Fehler der Engine (non-2xx). Trägt den Status für Retry-Entscheidungen. */
export class RiskLayerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Roh-Body — NUR für gezielte, strukturierte Extraktion durch den Aufrufer
     *  (engineMessage/fehlerAusBody). NIE ungefiltert loggen: kann den
     *  analysierten Mandanten-Sachverhalt enthalten (§ 203). */
    readonly body: string,
  ) {
    // WICHTIG: die (häufig geloggte) message trägt NUR strukturierte Felder,
    // nicht den Roh-Body. Vorher: `body.slice(0, 200)` → potenzieller §203-Leak.
    const label = extractRiskLayerError(body);
    super(`Risk-Layer ${path} antwortete ${status}${label ? `: ${label}` : ''}`);
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
  /** Override des fetch (Tests); Default: trustedRiskLayerFetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Geteilter Breaker (Tests/DI); Default: neuer pro Client. */
  breaker?: CircuitBreaker;
}

export class RiskLayerClient {
  private readonly url: string;
  private readonly token: string;
  private readonly operatorToken: string | undefined;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly breaker: CircuitBreaker;

  constructor(opts: RiskLayerClientOptions = {}) {
    const cfg = opts.config ?? requireRiskLayerConfig();
    this.url = cfg.url.replace(/\/$/, '');
    this.token = cfg.token;
    this.operatorToken = cfg.operatorToken;
    this.fetchImpl = opts.fetchImpl ?? trustedRiskLayerFetch;
    this.breaker = opts.breaker ?? new CircuitBreaker(BREAKER_DEFAULTS);
  }

  // --- Analyse (Zwei-Phasen) ------------------------------------------------

  /**
   * `POST /v1/analyse`. `mitLLM:false` (Default) = schnell/deterministisch und
   * retrybar; `mitLLM:true` = LLM-Schicht, langer Timeout, KEIN Auto-Retry.
   */
  async analyse(input: ZweiphasenAnalyseInput): Promise<RiskAnalysisResult> {
    const mitLLM = input.mitLLM ?? false;
    const body: Record<string, unknown> = {
      text: input.text,
      mitLLM,
      optionen: input.optionen ?? {},
    };
    if (input.nutzer) body.nutzer = input.nutzer;
    const raw = await this.request('POST', '/v1/analyse', {
      body,
      timeoutMs: mitLLM ? LLM_TIMEOUT_MS : FAST_TIMEOUT_MS,
      retry: mitLLM ? NO_RETRY : FAST_RETRY,
    });
    // mapAnalyse validiert das Envelope vollständig (AnalyseResponseSchema)
    // selbst — kein separater Vorab-parse (doppelte Validierungslast).
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

  /**
   * `POST /v1/katalog/review` — Review-Lebenszyklus eines GETEILTEN Berater-
   * Eintrags (entwurf → geprüft → freigegeben, NUR vorwärts; seit Engine 1.1.0).
   * Schreibend → KEIN Auto-Retry. Lebenszyklus-Ablehnungen (Rückwärts-Übergang,
   * unbekannte id) kommen als HTTP 400 mit `{ok:false, fehler}` → der `request`-
   * Pfad wirft RiskLayerHttpError; der Aufrufer übersetzt das in einen
   * Domänenfehler. Die Antwort nennt den VOLLSTÄNDIGEN Übergang (alter_status →
   * neuer_status) für den Audit-Chain-Eintrag des Hosts (§4: die Engine
   * auditiert nicht).
   */
  async katalogReview(input: {
    id: string;
    status: KatalogReviewStatus;
    /** Prüfer-Kennung (StaffUser-ID) — Engine-Default ist 'berater'. */
    pruefer?: string;
  }): Promise<KatalogReviewResponse> {
    const raw = await this.request('POST', '/v1/katalog/review', {
      body: input,
      retry: NO_RETRY,
    });
    return KatalogReviewResponseSchema.parse(raw);
  }

  /**
   * `POST /v1/katalog/norm_kuratieren` — katalogweite Norm-Kuratierung einer
   * Begriffs-Karte (verwerfen/ergaenzen/zuruecksetzen). Begriff-scoped, kein
   * Falltext (§203). Idempotent, aber schreibend → KEIN Auto-Retry.
   */
  async katalogNormKuratieren(input: {
    katalogId: string;
    norm: string;
    aktion: 'verwerfen' | 'ergaenzen' | 'zuruecksetzen';
    scope: 'personal' | 'geteilt';
    autor: string;
  }): Promise<KatalogKuratiereResponse> {
    const raw = await this.request('POST', '/v1/katalog/norm_kuratieren', {
      body: {
        katalog_id: input.katalogId,
        norm: input.norm,
        aktion: input.aktion,
        scope: input.scope,
        autor: input.autor,
      },
      retry: NO_RETRY,
    });
    return KatalogKuratiereResponseSchema.parse(raw);
  }

  /**
   * `GET /v1/katalog/kuratierung?katalog_id=&nutzer=` — aufbereitete Sicht eines
   * Begriffs (verworfene Norm-IDs + ergänzte Normen) zum Überlagern der Anzeige.
   * Read-only/idempotent → retrybar.
   */
  async katalogKuratierungBegriff(input: {
    katalogId: string;
    nutzer?: string;
  }): Promise<KatalogKuratierungBegriff> {
    const query: Record<string, string> = { katalog_id: input.katalogId };
    if (input.nutzer) query.nutzer = input.nutzer;
    const raw = await this.request('GET', '/v1/katalog/kuratierung', { query, retry: FAST_RETRY });
    return KatalogKuratierungBegriffSchema.parse(raw);
  }

  /** `GET /v1/katalog/kuratierung?nutzer=` — ALLE Kuratierungen (Review), scope-
   *  gefiltert. Ohne `katalog_id`. Read-only/idempotent → retrybar. */
  async katalogKuratierungAlle(input: { nutzer?: string } = {}): Promise<KatalogKuratierungListe> {
    const query: Record<string, string> = {};
    if (input.nutzer) query.nutzer = input.nutzer;
    const raw = await this.request('GET', '/v1/katalog/kuratierung', { query, retry: FAST_RETRY });
    return KatalogKuratierungListeSchema.parse(raw);
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

  /** `GET /v1/embedding/status` — Index-, Job- und Zeitplanstatus. */
  async embeddingStatus(): Promise<EmbeddingStatusResponse> {
    const raw = await this.request('GET', '/v1/embedding/status', { retry: FAST_RETRY });
    return EmbeddingStatusResponseSchema.parse(raw);
  }

  /** `POST /v1/embedding/refresh` — startet einen Single-Flight-Neuaufbau. */
  async embeddingRefresh(input: { force: boolean }): Promise<EmbeddingRefreshResponse> {
    const raw = await this.request('POST', '/v1/embedding/refresh', {
      body: { force: input.force },
      retry: NO_RETRY,
      operator: true,
    });
    return EmbeddingRefreshResponseSchema.parse(raw);
  }

  /** `POST /v1/embedding/cancel` — bricht genau den beobachteten Job ab. */
  async embeddingCancel(input: { jobId: string }): Promise<EmbeddingCancelResponse> {
    const raw = await this.request('POST', '/v1/embedding/cancel', {
      body: { job_id: input.jobId },
      retry: NO_RETRY,
      operator: true,
    });
    return EmbeddingCancelResponseSchema.parse(raw);
  }

  /** `POST /v1/embedding/schedule` — konfiguriert die automatische Prüfung. */
  async embeddingSchedule(input: {
    enabled: boolean;
    intervalDays: number;
  }): Promise<EmbeddingScheduleResponse> {
    const raw = await this.request('POST', '/v1/embedding/schedule', {
      body: { enabled: input.enabled, interval_days: input.intervalDays },
      retry: NO_RETRY,
      operator: true,
    });
    return EmbeddingScheduleResponseSchema.parse(raw);
  }

  // --- Quantenlos (blinde Compliance-Stichprobe, Engine 1.3.0) ---------------

  /**
   * `POST /v1/los/ziehen` — zieht eine beweisbar blinde Stichprobe (k aus dem
   * Rahmen). KEIN Auto-Retry: ein Retry könnte einen zweiten QPU-Job einreihen
   * (Doppel-Ziehung). `wartet` (QPU-Queue) ⇒ job_id merken und `losAbholen`.
   * `ibmToken` (Engine ≥ 1.3.1): zentral verwalteter IBM-Zugang pro Request —
   * die Engine persistiert/loggt ihn nie; ohne ihn gilt ihr Maschinen-Zugang.
   */
  async losZiehen(input: {
    rahmen: string[];
    k: number;
    backend: LosBackend;
    ibmToken?: string;
  }): Promise<LosErgebnis> {
    const body: Record<string, unknown> = {
      rahmen: input.rahmen,
      k: input.k,
      backend: input.backend,
    };
    if (input.ibmToken) body.ibm_token = input.ibmToken;
    const raw = await this.request('POST', '/v1/los/ziehen', {
      body,
      timeoutMs: LOS_TIMEOUT_MS,
      retry: NO_RETRY,
    });
    return LosErgebnisSchema.parse(raw);
  }

  /**
   * `POST /v1/los/abholen` — holt das Ergebnis eines wartenden QPU-Jobs ab.
   * Idempotenter Poll (die Engine zieht nicht erneut) → retrybar. Antwortet
   * weiter in der wartet-Form, solange der Job in der IBM-Queue liegt.
   */
  async losAbholen(input: {
    jobId: string;
    rahmen: string[];
    k: number;
    ibmToken?: string;
  }): Promise<LosErgebnis> {
    const body: Record<string, unknown> = { job_id: input.jobId, rahmen: input.rahmen, k: input.k };
    if (input.ibmToken) body.ibm_token = input.ibmToken;
    const raw = await this.request('POST', '/v1/los/abholen', {
      body,
      timeoutMs: LOS_TIMEOUT_MS,
      retry: FAST_RETRY,
    });
    return LosErgebnisSchema.parse(raw);
  }

  /**
   * `POST /v1/los/pruefen` — verifiziert einen Nachweis gegen den Rahmen
   * (Commitment, Ableitung; `online:true` zusätzlich die IBM-Job-Attestierung,
   * `ibmToken` optional für den Online-Refetch). Read-only/idempotent → retrybar.
   */
  async losPruefen(input: {
    nachweis: LosNachweis;
    rahmen: string[];
    online?: boolean;
    ibmToken?: string;
  }): Promise<LosPruefenResponse> {
    const body: Record<string, unknown> = { nachweis: input.nachweis, rahmen: input.rahmen };
    if (input.online !== undefined) body.online = input.online;
    if (input.ibmToken) body.ibm_token = input.ibmToken;
    const raw = await this.request('POST', '/v1/los/pruefen', {
      body,
      timeoutMs: LOS_TIMEOUT_MS,
      retry: FAST_RETRY,
    });
    return LosPruefenResponseSchema.parse(raw);
  }

  // --- Health ---------------------------------------------------------------

  /** `GET /v1/health`. */
  async health(): Promise<HealthResponse> {
    const raw = await this.request('GET', '/v1/health', { retry: NO_RETRY });
    return HealthResponseSchema.parse(raw);
  }

  // --- LLM-Steuerung (Schicht 2) --------------------------------------------

  /** `GET /v1/llm/status` — Verfügbarkeit + Queue-Auslastung des llama-server.
   *  Idempotent/billig → retrybar. So entscheidet TaxTronik: jetzt mitLLM senden
   *  oder auf Bereitschaft warten. */
  async llmStatus(): Promise<LlmStatusResponse> {
    const raw = await this.request('GET', '/v1/llm/status', { retry: FAST_RETRY });
    return LlmStatusResponseSchema.parse(raw);
  }

  /** `POST /v1/llm/start` — startet den llama-server (idempotent, non-blocking).
   *  KEIN Request-Input (Modell/Binary aus der Engine-Config → kein Injection-
   *  Vektor); Bereitschaft anschließend über `llmStatus().verfuegbar` pollen. */
  async llmStart(): Promise<LlmStartResponse> {
    const raw = await this.request('POST', '/v1/llm/start', { retry: FAST_RETRY });
    return LlmStartResponseSchema.parse(raw);
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
      operator?: boolean;
    },
  ): Promise<unknown> {
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const url = `${this.url}${path}${qs}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    if (opts.operator) {
      if (!this.operatorToken) throw new RiskLayerOperatorNotConfiguredError();
      headers['x-risk-layer-operator-token'] = this.operatorToken;
    }
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
