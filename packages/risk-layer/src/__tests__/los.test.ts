// =============================================================================
// Quantenlos-Client (/v1/los/*) — Vertrags-Tests mit gemocktem fetch.
//
// Die Fixtures bilden die Engine-Formen (1.3.0) exakt ab: fertig-Form mit
// vollem Nachweis, wartet-Form (QPU-Queue) inkl. wartet→abholen-Folge, 503.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { RiskLayerClient, RiskLayerHttpError } from '../index';

const config = { url: 'http://risk-layer:8000', token: 'x'.repeat(32) };

// Vertrags-Fixture: fertige Ziehung (csprng-Fallback, kein job_id).
const nachweisFixture = {
  protokoll_version: 1,
  gezogen_am: '2026-06-10T08:00:00Z',
  rahmen: { commitment: 'c0ffee'.repeat(8), n: 3 },
  k: 2,
  stichprobe: ['a1', 'c3'],
  entropie: {
    quelle_klasse: 'csprng',
    backend: 'csprng',
    roh_counts_sha256: 'ab'.repeat(32),
  },
  ableitung: { extraktor: 'sha256-vn', drbg: 'hmac-drbg-sha256' },
};
const fertigFixture = { ok: true, status: 'fertig', nachweis: nachweisFixture };

// Vertrags-Fixture: QPU-Queue (Job läuft noch bei IBM).
const wartetFixture = {
  ok: true,
  status: 'wartet',
  job_id: 'ibm-job-42',
  backend: 'qpu',
  commitment: 'c0ffee'.repeat(8),
  k: 2,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RiskLayerClient — Quantenlos', () => {
  it('losZiehen postet rahmen/k/backend mit Bearer an /v1/los/ziehen und parst die fertig-Form', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(fertigFixture));
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.losZiehen({ rahmen: ['a1', 'b2', 'c3'], k: 2, backend: 'csprng' });
    expect(r.status).toBe('fertig');
    if (r.status === 'fertig') {
      expect(r.nachweis.stichprobe).toEqual(['a1', 'c3']);
      expect(r.nachweis.rahmen).toMatchObject({ commitment: 'c0ffee'.repeat(8), n: 3 });
      expect(r.nachweis.entropie.quelle_klasse).toBe('csprng');
    }

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/los/ziehen');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${config.token}`);
    expect(JSON.parse(init!.body as string)).toEqual({ rahmen: ['a1', 'b2', 'c3'], k: 2, backend: 'csprng' });
  });

  it('losZiehen liefert die wartet-Form (QPU-Queue) mit job_id durch', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(wartetFixture));
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.losZiehen({ rahmen: ['a1', 'b2', 'c3'], k: 2, backend: 'qpu' });
    expect(r.status).toBe('wartet');
    if (r.status === 'wartet') {
      expect(r.job_id).toBe('ibm-job-42');
      expect(r.backend).toBe('qpu');
      expect(r.commitment).toBe('c0ffee'.repeat(8));
      expect(r.k).toBe(2);
    }
  });

  it('losZiehen wird bei 503 NICHT retried (Doppel-Ziehung verboten)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: false, fehler: 'QPU nicht erreichbar' }, 503),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    await expect(
      client.losZiehen({ rahmen: ['a1'], k: 1, backend: 'qpu' }),
    ).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('wartet→abholen-Folge: losAbholen pollt mit job_id (snake_case) und liefert dann die fertig-Form', async () => {
    const fetchImpl = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>();
    // Erster Poll: Job hängt noch in der IBM-Queue.
    fetchImpl.mockResolvedValueOnce(jsonResponse(wartetFixture));
    // Zweiter Poll: fertig — Nachweis trägt jetzt die QPU-Provenienz.
    const qpuNachweis = {
      ...nachweisFixture,
      entropie: {
        quelle_klasse: 'qpu',
        backend: 'ibm_torino',
        job_id: 'ibm-job-42',
        job_tags: ['taxtronik', 'quantenlos'],
        roh_counts_sha256: 'cd'.repeat(32),
      },
    };
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: true, status: 'fertig', nachweis: qpuNachweis }));
    const client = new RiskLayerClient({ config, fetchImpl });

    const erst = await client.losAbholen({ jobId: 'ibm-job-42', rahmen: ['a1', 'b2', 'c3'], k: 2 });
    expect(erst.status).toBe('wartet');

    const dann = await client.losAbholen({ jobId: 'ibm-job-42', rahmen: ['a1', 'b2', 'c3'], k: 2 });
    expect(dann.status).toBe('fertig');
    if (dann.status === 'fertig') {
      expect(dann.nachweis.entropie.job_id).toBe('ibm-job-42');
      expect(dann.nachweis.entropie.quelle_klasse).toBe('qpu');
    }

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/los/abholen');
    expect(JSON.parse(init!.body as string)).toEqual({ job_id: 'ibm-job-42', rahmen: ['a1', 'b2', 'c3'], k: 2 });
  });

  it('losAbholen retried bei 503 (idempotenter Poll) und liefert dann', async () => {
    const fetchImpl = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: false, fehler: 'kurz weg' }, 503));
    fetchImpl.mockResolvedValueOnce(jsonResponse(fertigFixture));
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.losAbholen({ jobId: 'ibm-job-42', rahmen: ['a1'], k: 1 });
    expect(r.status).toBe('fertig');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('losPruefen sendet nachweis+rahmen (+online) und parst gueltig/geprueft/hinweise', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        gueltig: true,
        geprueft: ['commitment', 'ableitung', 'ibm_attestierung'],
        hinweise: ['Online-Attestierung gegen IBM Quantum geprüft.'],
      }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.losPruefen({
      nachweis: nachweisFixture,
      rahmen: ['a1', 'b2', 'c3'],
      online: true,
    });
    expect(r.gueltig).toBe(true);
    expect(r.geprueft).toContain('commitment');
    expect(r.hinweise).toHaveLength(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/los/pruefen');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      nachweis: { protokoll_version: 1, k: 2 },
      rahmen: ['a1', 'b2', 'c3'],
      online: true,
    });
  });

  it('losPruefen wirft bei 422 (kaputter Nachweis) RiskLayerHttpError ohne Retry', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: false, fehler: 'nachweis: protokoll_version fehlt' }, 422),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    await expect(
      client.losPruefen({ nachweis: nachweisFixture, rahmen: ['a1'] }),
    ).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
