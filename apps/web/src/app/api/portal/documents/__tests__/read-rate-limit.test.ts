// =============================================================================
// Unit-Tests: Read-Rate-Limit der Portal-Dokument-Routen (Audit 2026-06,
// Befund 6).
//
// Download- und Preview-Route schreiben pro Abruf einen Audit-Eintrag
// (evidenceService.record) — das Limit pro Session-Kontakt muss deshalb VOR
// dem DB-Zugriff greifen, sonst bleibt der Audit-Spam-Vektor offen.
//
// Prisma/Storage/Auth/Rate-Limit komplett gemockt (Muster: magic-link.test.ts);
// die Route-Handler laufen echt.
//
// Abgedeckt (je Route):
//   - keine Session → 401, Limiter wird NICHT konsumiert
//   - Limit überschritten → 429 mit retryAfter, KEIN DB-Zugriff, KEIN Audit
//   - Happy Path → Limiter mit contactId konsumiert, Audit geschrieben
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  portalAuth: vi.fn(),
  checkPortalReadLimit: vi.fn(),
  getClientIp: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  streamObject: vi.fn(),
  tx: {
    document: { findFirst: vi.fn() },
  },
}));

vi.mock('@/server/auth/portal', () => ({ portalAuth: m.portalAuth }));
vi.mock('@/server/rate-limit', () => ({
  checkPortalReadLimit: m.checkPortalReadLimit,
  getClientIp: m.getClientIp,
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@taxtronik/storage', () => ({
  streamObject: m.streamObject,
  sanitizeFilenameForHeader: (s: string) => s,
}));
vi.mock('@/server/storage/preview-mime', () => ({
  filenameWithExtension: (title: string) => title,
  previewContentType: (mime: string | null) => mime ?? 'application/octet-stream',
  previewDisposition: () => 'inline',
  previewSecurityHeaders: () => ({}),
}));

import { NextRequest } from 'next/server';
import { GET as downloadGet } from '../[id]/download/route';
import { GET as previewGet } from '../[id]/preview-url/route';

const SESSION = {
  user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: 'client-1' },
};

const DOCUMENT = {
  id: 'doc-1',
  title: 'BWA Mai',
  mimeType: 'application/pdf',
  versions: [{ versionNo: 1, storageBucket: 'docs', storageKey: 'k/doc-1' }],
};

function params(id = 'doc-1') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-Path-Defaults — einzelne Tests verstellen gezielt.
  m.portalAuth.mockResolvedValue(SESSION);
  m.checkPortalReadLimit.mockResolvedValue({ ok: true, remaining: 239, retryAfter: 0 });
  m.getClientIp.mockReturnValue('203.0.113.7');
  m.tx.document.findFirst.mockResolvedValue(DOCUMENT);
  m.evidenceRecord.mockResolvedValue({});
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(m.tx),
  );
  m.streamObject.mockResolvedValue({ body: 'bytes', contentLength: 5 });
});

// Beide Routen müssen sich identisch verhalten — gemeinsamer Bucket, gleiche
// Reihenfolge Auth → Limit → DB/Audit.
const ROUTES = [
  {
    name: 'download',
    call: (id?: string) =>
      downloadGet(
        new NextRequest('http://portal.example.de/api/portal/documents/doc-1/download'),
        params(id),
      ),
  },
  {
    name: 'preview-url',
    call: (id?: string) =>
      previewGet(
        new NextRequest('http://portal.example.de/api/portal/documents/doc-1/preview-url'),
        params(id),
      ),
  },
] as const;

describe.each(ROUTES)('Portal-Read-Limit: $name-Route', ({ call }) => {
  it('keine Session → 401, Limiter wird NICHT konsumiert', async () => {
    m.portalAuth.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(m.checkPortalReadLimit).not.toHaveBeenCalled();
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('Limit überschritten → 429 mit retryAfter, KEIN DB-Zugriff, KEIN Audit-Eintrag', async () => {
    m.checkPortalReadLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfter: 120 });
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(await res.json()).toEqual({ error: 'rate_limited', retryAfter: 120 });
    // Kern von Befund 6: bei Drosselung darf KEIN Audit-Eintrag entstehen.
    expect(m.withTenantContext).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('Happy Path → Limiter mit Session-contactId konsumiert, Audit geschrieben', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.checkPortalReadLimit).toHaveBeenCalledTimes(1);
    expect(m.checkPortalReadLimit).toHaveBeenCalledWith('contact-1');
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
  });
});

describe('Preview-Route — Antwortformen unter Limit', () => {
  it('ohne ?stream=1 → JSON-Metadata mit Stream-URL', async () => {
    const res = await previewGet(
      new NextRequest('http://portal.example.de/api/portal/documents/doc-1/preview-url'),
      params(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: '/api/portal/documents/doc-1/preview-url?stream=1',
      mimeType: 'application/pdf',
      title: 'BWA Mai',
    });
  });

  it('?stream=1 konsumiert den Limiter ebenfalls (2 Requests pro Preview)', async () => {
    const res = await previewGet(
      new NextRequest('http://portal.example.de/api/portal/documents/doc-1/preview-url?stream=1'),
      params(),
    );
    expect(res.status).toBe(200);
    expect(m.checkPortalReadLimit).toHaveBeenCalledTimes(1);
    expect(m.streamObject).toHaveBeenCalledWith('docs', 'k/doc-1');
  });
});
