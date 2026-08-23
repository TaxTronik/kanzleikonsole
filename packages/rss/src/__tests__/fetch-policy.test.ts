import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('@taxtronik/http-utils', () => ({ safeFetch: mocks.safeFetch }));

import { fetchRssFeed } from '../index';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeFetch.mockResolvedValue(
    new Response(
      '<rss><channel><item><title>Hinweis</title><link>https://news.example/item</link></item></channel></rss>',
      { status: 200 },
    ),
  );
});

describe('fetchRssFeed SSRF policy', () => {
  it('uses the strict public policy instead of the infrastructure allowlist', async () => {
    await fetchRssFeed('https://feeds.example/rss.xml');

    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'https://feeds.example/rss.xml',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: expect.stringContaining('application/rss+xml'),
        }),
      }),
      { mode: 'public' },
    );
  });
});
