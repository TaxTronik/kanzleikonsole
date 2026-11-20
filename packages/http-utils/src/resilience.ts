// =============================================================================
// Resilienz: Circuit-Breaker + begrenztes Retry mit Backoff.
//
// Gemeinsam für die internen Dienst-Clients (Risk-Layer/Signal, TCMS). Bis
// TCMS Stufe 2 lag das Modul in @taxtronik/risk-layer; ein zweiter Client
// hätte eine Kopie gebraucht, die bei jeder Härtung mitgezogen werden muss.
//
// Ein Dienst kann zeitweise überlastet oder aus sein. Damit ein Ausfall nicht
// jeden Aufruf in den Timeout laufen lässt, schützt ein Circuit-Breaker pro
// Client-Instanz: nach N Fehlern in Folge „öffnet" er und lehnt Calls sofort ab
// (CircuitOpenError), bis nach einer Cooldown-Zeit ein Probe-Call (half-open)
// erlaubt wird.
//
// Retry NUR für idempotente, billige Calls. Welche Fehler wiederholt werden und
// welche als Ausfall des Dienstes zählen, entscheidet der Aufrufer
// (`shouldRetry`, `countsAsFailure`).
// =============================================================================

export type CircuitState = 'closed' | 'open' | 'half-open';
type RequestOutcome = 'success' | 'failure' | 'ignored';

const DEFAULT_OPEN_MESSAGE = 'Circuit ist offen — Dienst gilt als nicht erreichbar.';

export interface CircuitBreakerOptions {
  /** Aufeinanderfolgende Fehler, ab denen der Breaker öffnet. */
  failureThreshold: number;
  /** Cooldown (ms), nach dem ein offener Breaker einen Probe-Call zulässt. */
  resetTimeoutMs: number;
  /** Zeitquelle (injizierbar für Tests). Default: Date.now. */
  now?: () => number;
  /** Meldung des CircuitOpenError (dienstspezifisch, ohne Interna). */
  openMessage?: string;
}

export class CircuitOpenError extends Error {
  constructor(message: string = DEFAULT_OPEN_MESSAGE) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private generation = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    // Lazy-Übergang open → half-open, wenn die Cooldown abgelaufen ist.
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.resetTimeoutMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** Wirft CircuitOpenError, wenn aktuell kein Call erlaubt ist. */
  assertCanRequest(): void {
    if (this.getState() === 'open' || this.probeInFlight) {
      throw new CircuitOpenError(this.opts.openMessage);
    }
  }

  /** Reserve a half-open probe and bind its result to the current outage. */
  beginRequest(): (outcome: RequestOutcome) => void {
    this.assertCanRequest();
    const generation = this.generation;
    if (this.state === 'half-open') this.probeInFlight = true;
    return (outcome) => {
      if (this.generation !== generation) return;
      this.probeInFlight = false;
      if (outcome === 'success') this.onSuccess();
      if (outcome === 'failure') this.onFailure();
    };
  }

  onSuccess(): void {
    if (this.state !== 'closed') this.generation += 1;
    this.probeInFlight = false;
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    this.failures += 1;
    // Ein Fehler im half-open-Probe-Call öffnet sofort wieder.
    if (this.state === 'half-open' || this.failures >= this.opts.failureThreshold) {
      this.generation += 1;
      this.probeInFlight = false;
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

export interface RetryOptions {
  /** Anzahl zusätzlicher Versuche nach dem ersten (0 = kein Retry). */
  retries: number;
  /** Basis-Delay (ms); wächst exponentiell pro Versuch. */
  baseDelayMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Führt `fn` aus und wiederholt bei `shouldRetry`-Fehlern mit exponentiellem
 * Backoff (baseDelay * 2^versuch). Gibt den letzten Fehler weiter, wenn alle
 * Versuche scheitern.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  shouldRetry: (err: unknown) => boolean,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries || !shouldRetry(err)) throw err;
      await sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Kombiniert Breaker + Retry: lehnt bei offenem Breaker sofort ab, sonst
 * `withRetry`, und meldet Erfolg/Fehler an den Breaker zurück. Ein
 * CircuitOpenError aus dem Retry zählt nicht erneut als Dienst-Fehler.
 *
 * `countsAsFailure` (Standard: jeder Fehler): Fehler, die zeigen, dass der
 * Dienst erreichbar ist und fachlich antwortet (z. B. 404 beim TCMS), zählen
 * nicht als Ausfall und setzen den Zähler wie ein Erfolg zurück.
 */
export async function executeResilient<T>(
  breaker: CircuitBreaker,
  retry: RetryOptions,
  shouldRetry: (err: unknown) => boolean,
  fn: () => Promise<T>,
  countsAsFailure: (err: unknown) => boolean = () => true,
): Promise<T> {
  const finish = breaker.beginRequest();
  let outcome: RequestOutcome = 'ignored';
  try {
    const result = await withRetry(fn, retry, shouldRetry);
    outcome = 'success';
    return result;
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) outcome = countsAsFailure(err) ? 'failure' : 'success';
    throw err;
  } finally {
    finish(outcome);
  }
}
