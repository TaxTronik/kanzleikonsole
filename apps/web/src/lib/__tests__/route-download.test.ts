import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFilename, downloadFromRoute } from '../route-download';

function stubDocument() {
  const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
  return link;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadFilename', () => {
  it('prefers the UTF-8 filename and falls back to the plain or default name', () => {
    const header = `attachment; filename="Analyse __.pdf"; filename*=UTF-8''${encodeURIComponent('Analyse Łódź.pdf')}`;
    expect(downloadFilename(header, 'x.pdf')).toBe('Analyse Łódź.pdf');
    expect(
      downloadFilename(`attachment; filename="Analyse.pdf"; filename*=UTF-8''%E0%A4%A`, 'x'),
    ).toBe('Analyse.pdf');
    expect(downloadFilename(null, 'Subsumtion.pdf')).toBe('Subsumtion.pdf');
  });
});

describe('downloadFromRoute', () => {
  it('returns the route message instead of navigating to its JSON error', async () => {
    const link = stubDocument();
    const message = 'PDF-Ausgabe gesperrt: Zeichen U+1F600 sind … nicht verlustfrei darstellbar.';
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'unsupported_text', message }, { status: 422 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadFromRoute('/api/export?format=pdf', 'Subsumtion.pdf')).resolves.toBe(
      message,
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/export?format=pdf', { cache: 'no-store' });
    expect(link.click).not.toHaveBeenCalled();
  });

  it('falls back to the error code, the status and a network message', async () => {
    stubDocument();
    vi.stubGlobal('fetch', async () => Response.json({ error: 'rate_limited' }, { status: 429 }));
    await expect(downloadFromRoute('/a', 'a.pdf')).resolves.toBe('rate_limited');
    vi.stubGlobal('fetch', async () => new Response('Internal Server Error', { status: 500 }));
    await expect(downloadFromRoute('/a', 'a.pdf')).resolves.toBe('Fehler (500)');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(downloadFromRoute('/a', 'a.pdf')).resolves.toBe(
      'Netzwerkfehler — bitte erneut versuchen.',
    );
  });

  it('saves a successful response under its UTF-8 filename', async () => {
    const link = stubDocument();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('%PDF-1.7', {
          headers: {
            'content-disposition': `attachment; filename="Bericht __.pdf"; filename*=UTF-8''${encodeURIComponent('Bericht Dvořák.pdf')}`,
          },
        }),
    );
    await expect(downloadFromRoute('/a', 'Subsumtion.pdf')).resolves.toBeNull();
    expect(link.download).toBe('Bericht Dvořák.pdf');
    expect(link.href).toMatch(/^blob:/);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(link.href);
  });
});
