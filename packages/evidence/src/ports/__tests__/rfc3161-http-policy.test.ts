import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('@taxtronik/http-utils', () => ({ safeFetch: mocks.safeFetch }));

import { Rfc3161HttpAdapter } from '../rfc3161-http';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeFetch.mockRejectedValue(new Error('stop after policy capture'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Rfc3161HttpAdapter SSRF policy', () => {
  it('uses the strict public policy for every TSA request', async () => {
    const adapter = new Rfc3161HttpAdapter('https://tsa.example/tsr');

    await expect(adapter.timestamp(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'stop after policy capture',
    );
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'https://tsa.example/tsr',
      expect.objectContaining({ method: 'POST' }),
      { mode: 'public' },
    );
  });

  it('rejects an advertised response body above the hard size limit', async () => {
    mocks.safeFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x30, 0x00]), {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
    );
    const adapter = new Rfc3161HttpAdapter('https://tsa.example/tsr');

    await expect(adapter.timestamp(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Größenlimit/);
  });

  it('keeps the request timeout active while the response body is still streaming', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    mocks.safeFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal!.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    const adapter = new Rfc3161HttpAdapter('https://tsa.example/tsr', 25);
    const pending = adapter.timestamp(new Uint8Array([1, 2, 3]));
    const rejection = expect(pending).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});
