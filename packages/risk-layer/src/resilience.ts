// =============================================================================
// Resilienz: Circuit-Breaker + begrenztes Retry mit Backoff.
//
// Die LLM-Schicht der Engine kann 15–30 s dauern und zeitweise überlastet/aus
// sein. Damit ein Ausfall nicht jeden Aufruf in den Timeout laufen lässt,
// schützt ein Circuit-Breaker pro Client-Instanz: nach N Fehlern in Folge
// „öffnet" er und lehnt Calls sofort ab (CircuitOpenError), bis nach einer
// Cooldown-Zeit ein Probe-Call (half-open) erlaubt wird.
//
// Retry NUR für idempotente, billige Calls (GET + schnelle Analyse). Der teure
// LLM-Call wird nicht auto-retried (Caller setzt retries: 0).
// =============================================================================

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Aufeinanderfolgende Fehler, ab denen der Breaker öffnet. */
  failureThreshold: number;
  /** Cooldown (ms), nach dem ein offener Breaker einen Probe-Call zulässt. */
  resetTimeoutMs: number;
  /** Zeitquelle (injizierbar für Tests). Default: Date.now. */
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor() {
    super('Risk-Layer-Circuit ist offen — Engine gilt als nicht erreichbar.');
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
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
    if (this.getState() === 'open') throw new CircuitOpenError();
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    this.failures += 1;
    // Ein Fehler im half-open-Probe-Call öffnet sofort wieder.
    if (this.state === 'half-open' || this.failures >= this.opts.failureThreshold) {
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
 * CircuitOpenError aus dem Retry zählt nicht erneut als Engine-Fehler.
 */
export async function executeResilient<T>(
  breaker: CircuitBreaker,
  retry: RetryOptions,
  shouldRetry: (err: unknown) => boolean,
  fn: () => Promise<T>,
): Promise<T> {
  breaker.assertCanRequest();
  try {
    const result = await withRetry(fn, retry, shouldRetry);
    breaker.onSuccess();
    return result;
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) breaker.onFailure();
    throw err;
  }
}
