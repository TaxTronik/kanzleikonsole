import { describe, it, expect, vi } from 'vitest';
import { RiskLayerClient, RiskLayerHttpError } from '../index';

const config = { url: 'http://risk-layer:8000', token: 'x'.repeat(32) };
const analysePayload = { textHash: 'h', katalogVersion: 'k', engineVersion: 'e', spans: [] };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RiskLayerClient', () => {
  it('setzt Bearer-Header, ruft den richtigen Pfad und sendet mitLLM:false default', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(analysePayload));
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.analyse({ text: 'foo' });
    expect(r.textHash).toBe('h');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/analyse');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${config.token}`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ text: 'foo', mitLLM: false });
  });

  it('wirft RiskLayerHttpError bei 4xx und retried NICHT', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ error: 'bad' }, 400));
    const client = new RiskLayerClient({ config, fetchImpl });

    await expect(client.analyse({ text: 'x' })).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retried den schnellen Analyse-Call bei 503 und liefert dann', async () => {
    const fetchImpl = vi.fn<(u: string, i?: RequestInit) => Promise<Response>>();
    fetchImpl.mockResolvedValueOnce(jsonResponse({}, 503));
    fetchImpl.mockResolvedValueOnce(jsonResponse(analysePayload));
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.analyse({ text: 'x' });
    expect(r.textHash).toBe('h');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('katalogDefiniere wird bei 503 NICHT retried (Schreiben)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}, 503));
    const client = new RiskLayerClient({ config, fetchImpl });

    await expect(
      client.katalogDefiniere({ begriff: 'b', definition: 'd' }),
    ).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('katalogGet parst Version + Begriffe', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ version: 'v9', begriffe: [{ id: 'b1', begriff: 'Test', extra: 1 }] }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const k = await client.katalogGet();
    expect(k.version).toBe('v9');
    expect(k.begriffe[0]).toMatchObject({ id: 'b1', begriff: 'Test', extra: 1 });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://risk-layer:8000/v1/katalog');
  });
});
