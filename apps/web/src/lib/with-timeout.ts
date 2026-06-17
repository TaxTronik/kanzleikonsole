/**
 * Beschränkt ein Promise auf eine Maximaldauer. Verwirft bei Timeout mit einem
 * `TimeoutError` — schützt Request-/Action-Pfade, die sonst an externen
 * Schrittfolgen (CPU-PDF-Gen, Object-Store, ClamAV) endlos hängen können.
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation hat das Zeitlimit überschritten') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
