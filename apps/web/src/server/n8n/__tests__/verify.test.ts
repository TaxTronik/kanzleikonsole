// =============================================================================
// Unit-Test: verifyN8nSignature.
//
// Bewacht die HMAC-Verifikation für eingehende n8n-Calls. Dieser Test prüft:
//   - korrekte Signatur → ok
//   - Manipulation an Query (M-8/Audit Round 14, Finding 1) → mismatch
//   - Manipulation an Body / Pfad → mismatch
//   - falsches Secret → mismatch
//   - timestamp outside window → replay window error
//   - replay (nonce schon konsumiert) → replay detected
//   - nonce-store down (null) → 503 fail-closed
//
// Wir mocken `env` (N8N_HMAC_SECRET) und den Nonce-Store. Der eigentliche
// HMAC-Algorithmus läuft echt — wenn das Format kippt, schlägt das hier an.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// vi.mock-Factories werden ans Datei-Top gehoist — keine Top-Level-Variablen
// im Factory-Body verwenden. Wir nutzen vi.hoisted() für das Shared-State.
const { TEST_SECRET, consumeNonceMock } = vi.hoisted(() => ({
  TEST_SECRET: 'unit-test-hmac-secret-with-at-least-32-chars',
  consumeNonceMock: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({
  env: { N8N_HMAC_SECRET: TEST_SECRET },
}));

vi.mock('../nonce-store', () => ({
  consumeNonce: (...args: unknown[]) => consumeNonceMock(...args),
}));

import { NextRequest } from 'next/server';
import { verifyN8nSignature } from '../verify';

beforeEach(() => {
  consumeNonceMock.mockReset();
  // Default: Nonce wird erfolgreich konsumiert (Happy Path).
  consumeNonceMock.mockResolvedValue(true);
});

// -----------------------------------------------------------------------------
// Helper: NextRequest mit valider HMAC-Signatur bauen.
// -----------------------------------------------------------------------------

interface BuildOpts {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  ts?: number;
  signWith?: string;
  signPath?: string; // Override pathname+search beim Signieren (für Tampering-Tests)
  signBody?: string;
  extraHeaders?: Record<string, string>;
}

function buildRequest(opts: BuildOpts): NextRequest {
  const method = opts.method ?? 'GET';
  const body = opts.body ?? '';
  const ts = opts.ts ?? Date.now();
  const secret = opts.signWith ?? TEST_SECRET;
  const parsed = new URL(opts.url);
  const signPath = opts.signPath ?? `${parsed.pathname}${parsed.search}`;
  const signBody = opts.signBody ?? body;
  const payload = `${method} ${signPath}\n${ts}\n${signBody}`;
  const hex = createHmac('sha256', secret).update(payload).digest('hex');

  const headers: Record<string, string> = {
    'x-taxtronik-signature': `sha256=${hex}`,
    'x-taxtronik-timestamp': String(ts),
    ...(opts.extraHeaders ?? {}),
  };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    return new NextRequest(opts.url, { method, headers, body });
  }
  return new NextRequest(opts.url, { method, headers });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('verifyN8nSignature — Happy Path', () => {
  it('GET mit valider Signatur und Query → ok', async () => {
    const req = buildRequest({
      url: 'http://localhost/api/n8n/overdue-requests?tenantId=abc-123',
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(true);
  });

  it('POST mit valider Body-Signatur → ok, body wird zurückgegeben', async () => {
    const body = JSON.stringify({ event: 'taxtronik.ping' });
    const req = buildRequest({
      url: 'http://localhost/api/n8n/some-endpoint',
      method: 'POST',
      body,
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(true);
    expect(r.body).toBe(body);
  });
});

describe('verifyN8nSignature — Manipulationen werden erkannt', () => {
  it('Query-Manipulation: tenantId-Wert geändert nach Signing → mismatch', async () => {
    // Signiert wurde mit tenantId=victim, Request kommt aber mit tenantId=attacker.
    // Das ist genau der Cross-Tenant-Angriff aus Audit Round 14, Finding 1.
    const req = buildRequest({
      url: 'http://localhost/api/n8n/overdue-requests?tenantId=attacker',
      signPath: '/api/n8n/overdue-requests?tenantId=victim',
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mismatch/i);
  });

  it('Pfad-Manipulation: signed für /api/n8n/X, kommt an /api/n8n/Y → mismatch', async () => {
    const req = buildRequest({
      url: 'http://localhost/api/n8n/different-endpoint',
      signPath: '/api/n8n/original-endpoint',
    });
    expect((await verifyN8nSignature(req)).ok).toBe(false);
  });

  it('Body-Manipulation: signed für {a:1}, kommt {a:2} → mismatch', async () => {
    const req = buildRequest({
      url: 'http://localhost/api/n8n/x',
      method: 'POST',
      body: JSON.stringify({ a: 2 }),
      signBody: JSON.stringify({ a: 1 }),
    });
    expect((await verifyN8nSignature(req)).ok).toBe(false);
  });

  it('Falsches Secret → mismatch', async () => {
    const req = buildRequest({
      url: 'http://localhost/api/n8n/x',
      signWith: 'wrong-secret-with-at-least-32-chars-padding',
    });
    expect((await verifyN8nSignature(req)).ok).toBe(false);
  });
});

describe('verifyN8nSignature — Replay-Schutz', () => {
  it('Timestamp 10 min in der Vergangenheit → replay window', async () => {
    const req = buildRequest({
      url: 'http://localhost/api/n8n/x',
      ts: Date.now() - 10 * 60 * 1000,
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/replay window/i);
  });

  it('Timestamp 10 min in der Zukunft → replay window', async () => {
    const req = buildRequest({
      url: 'http://localhost/api/n8n/x',
      ts: Date.now() + 10 * 60 * 1000,
    });
    expect((await verifyN8nSignature(req)).ok).toBe(false);
  });

  it('Nonce schon konsumiert → replay detected', async () => {
    consumeNonceMock.mockResolvedValue(false);
    const req = buildRequest({ url: 'http://localhost/api/n8n/x' });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/replay detected/i);
  });

  it('Nonce-Store nicht erreichbar → 503 fail-CLOSED (NICHT pass-through)', async () => {
    consumeNonceMock.mockResolvedValue(null);
    const req = buildRequest({ url: 'http://localhost/api/n8n/x' });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.error).toMatch(/replay-store unavailable/);
  });

  it('Nonce-Wert ist die signature → derselbe Request darf zweimal geprüft werden, der Store unterscheidet', async () => {
    consumeNonceMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const req1 = buildRequest({ url: 'http://localhost/api/n8n/x', ts: Date.now() });
    const req2 = buildRequest({ url: 'http://localhost/api/n8n/x', ts: Date.now() });
    expect((await verifyN8nSignature(req1)).ok).toBe(true);
    expect((await verifyN8nSignature(req2)).ok).toBe(false);
  });
});

describe('verifyN8nSignature — Header-Validierung', () => {
  it('Fehlender x-taxtronik-signature → 401', async () => {
    const req = new NextRequest('http://localhost/api/n8n/x', {
      method: 'GET',
      headers: { 'x-taxtronik-timestamp': String(Date.now()) },
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toMatch(/missing x-taxtronik-signature/);
  });

  it('Fehlender x-taxtronik-timestamp → 401', async () => {
    const req = new NextRequest('http://localhost/api/n8n/x', {
      method: 'GET',
      headers: { 'x-taxtronik-signature': 'sha256=00' },
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing x-taxtronik-timestamp/);
  });

  it('Timestamp ist kein finite number → 401', async () => {
    const req = new NextRequest('http://localhost/api/n8n/x', {
      method: 'GET',
      headers: {
        'x-taxtronik-signature': 'sha256=00',
        'x-taxtronik-timestamp': 'NaN-or-junk',
      },
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid timestamp/);
  });

  it('Signatur falscher Länge → length mismatch (kein timing-leak)', async () => {
    const req = new NextRequest('http://localhost/api/n8n/x', {
      method: 'GET',
      headers: {
        // Viel zu kurz, aber gleicher Prefix
        'x-taxtronik-signature': 'sha256=deadbeef',
        'x-taxtronik-timestamp': String(Date.now()),
      },
    });
    const r = await verifyN8nSignature(req);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/length mismatch/);
  });
});
