import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('@taxtronik/http-utils', () => ({ safeFetch: mocks.safeFetch }));

import { Rfc3161HttpAdapter } from '../rfc3161-http';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeFetch.mockRejectedValue(new Error('stop after policy capture'));
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
});
