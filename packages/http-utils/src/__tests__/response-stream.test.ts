// Fachkatalog: AUDIT-RFC3161-ANCHOR-001 (shared transport for bounded TSA replies).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));
vi.mock('undici', () => ({
  fetch: transport.fetch,
  Agent: class {
    close = transport.close;
  },
}));

import { safeFetch } from '../index';

beforeEach(() => {
  transport.close.mockResolvedValue(undefined);
});
afterEach(() => vi.resetAllMocks());

describe('safeFetch response stream lifecycle', () => {
  it('does not drain an unconsumed remote body into an unbounded wrapper queue', async () => {
    let produced = 0;
    const cancel = vi.fn();
    transport.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
            if (++produced === 64) controller.close();
          },
          cancel,
        }),
      ),
    );
    const response = await safeFetch('https://stream.example.test/feed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const producedBeforeReading = produced;
    await response.body!.cancel('unused response');
    expect(producedBeforeReading).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it('propagates a size-limit cancellation to the reader that owns the upstream body', async () => {
    let first = true;
    const cancel = vi.fn();
    transport.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (first) controller.enqueue(new Uint8Array([1, 2, 3]));
            first = false;
          },
          cancel,
        }),
      ),
    );
    const response = await safeFetch('https://stream.example.test/feed');
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await reader.cancel('body limit reached');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('body limit reached');
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it('aborts an idle body and removes the abort listener when the transport closes', async () => {
    const cancel = vi.fn();
    transport.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const response = await safeFetch('https://stream.example.test/feed', {
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const pending = reader.read();
    const reason = new Error('consumer timeout');
    const rejection = expect(pending).rejects.toBe(reason);
    abort.abort(reason);
    await rejection;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('preserves complete response bytes and closes the transport exactly once', async () => {
    const abort = new AbortController();
    transport.fetch.mockResolvedValue(
      new Response('complete body', { status: 201, headers: { 'x-test': 'preserved' } }),
    );
    const response = await safeFetch('https://stream.example.test/feed', {
      signal: abort.signal,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-test')).toBe('preserved');
    expect(await response.text()).toBe('complete body');
    abort.abort();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
