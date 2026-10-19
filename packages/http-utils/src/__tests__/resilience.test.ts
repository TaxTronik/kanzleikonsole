import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, executeResilient, withRetry } from '../resilience';

describe('CircuitBreaker', () => {
  it('öffnet nach failureThreshold aufeinanderfolgenden Fehlern', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000, now: () => 1000 });
    expect(cb.getState()).toBe('closed');
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe('closed');
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    expect(() => cb.assertCanRequest()).toThrow(CircuitOpenError);
  });

  it('geht nach Cooldown in half-open und schließt bei Erfolg', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => t });
    cb.onFailure();
    expect(cb.getState()).toBe('open');
    t = 100;
    expect(cb.getState()).toBe('half-open');
    cb.onSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('öffnet im half-open sofort wieder bei erneutem Fehler', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => t });
    cb.onFailure();
    t = 100;
    expect(cb.getState()).toBe('half-open');
    cb.onFailure();
    expect(cb.getState()).toBe('open');
  });
});

describe('withRetry', () => {
  it('wiederholt bis retries erschöpft sind und wirft dann', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 0 }, () => true)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('bricht sofort ab, wenn shouldRetry false liefert', async () => {
    const fn = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(withRetry(fn, { retries: 5, baseDelayMs: 0 }, () => false)).rejects.toThrow(
      'nope',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('liefert beim ersten Erfolg ohne Wiederholung', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 0 }, () => true)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('executeResilient', () => {
  it('lehnt bei offenem Breaker sofort ab, ohne fn aufzurufen', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000, now: () => 0 });
    cb.onFailure();
    const fn = vi.fn(async () => 'x');
    await expect(
      executeResilient(cb, { retries: 0, baseDelayMs: 0 }, () => true, fn),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('meldet Erfolg an den Breaker zurück (Failure-Zähler zurückgesetzt)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: () => 0 });
    cb.onFailure();
    const fn = vi.fn(async () => 'ok');
    await expect(
      executeResilient(cb, { retries: 0, baseDelayMs: 0 }, () => true, fn),
    ).resolves.toBe('ok');
    expect(cb.getState()).toBe('closed');
  });
});

// TCMS Stufe 2: gemeinsamer Breaker für Risk-Layer und TCMS.
describe('dienstspezifische Fehlerzählung', () => {
  it('zählt nur Ausfälle, fachliche Antworten setzen den Zähler zurück', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: () => 0 });
    const ausfall = new Error('ausfall');
    const fachlich = new Error('404');
    const zaehlt = (err: unknown) => err === ausfall;
    const run = (err: Error) =>
      executeResilient(
        cb,
        { retries: 0, baseDelayMs: 0 },
        () => false,
        async () => {
          throw err;
        },
        zaehlt,
      ).catch(() => undefined);
    await run(ausfall);
    await run(fachlich);
    await run(ausfall);
    // Ohne Rücksetzen durch die fachliche Antwort wären es zwei Ausfälle in Folge.
    expect(cb.getState()).toBe('closed');
    await run(ausfall);
    expect(cb.getState()).toBe('open');
  });

  it('zählt ohne Angabe jeden Fehler (bisheriges Verhalten)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: () => 0 });
    await executeResilient(
      cb,
      { retries: 0, baseDelayMs: 0 },
      () => false,
      async () => {
        throw new Error('404');
      },
    ).catch(() => undefined);
    expect(cb.getState()).toBe('open');
  });

  it('nennt im CircuitOpenError die Meldung des Dienstes', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => 0,
      openMessage: 'TCMS-Circuit ist offen.',
    });
    cb.onFailure();
    expect(() => cb.assertCanRequest()).toThrow('TCMS-Circuit ist offen.');
    expect(new CircuitOpenError().message).toMatch(/Circuit ist offen/);
  });
});
