import { describe, it, expect, vi } from 'vitest';
import {
  EmbeddingStatusResponseSchema,
  RiskLayerClient,
  RiskLayerHttpError,
  RiskLayerOperatorNotConfiguredError,
} from '../index';

const config = { url: 'http://risk-layer:8000', token: 'x'.repeat(32) };
const analysePayload = {
  text_hash: 'h',
  katalog_version: 'k',
  engineVersion: 'e',
  karten: [],
  risiken: [],
};
const embeddingStatusPayload = {
  ok: true,
  engineVersion: '1.4.0',
  index: {
    active: true,
    current: false,
    fingerprint: 'sha256:abc',
    input_fingerprint: 'a'.repeat(64),
    encoder: 'encoder-v1',
    revision: 'catalogue-42',
  },
  job: {
    state: 'idle',
    id: null,
    requested: null,
    started: null,
    completed: null,
    last_success: '2026-08-10T09:00:00Z',
    error: null,
  },
  schedule: {
    enabled: true,
    interval_days: 7,
    last_check_at: '2026-08-10T09:00:00+00:00',
    next_run_at: '2026-08-17T09:00:00+00:00',
  },
  refresh_available: true,
  unavailable_reason: null,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RiskLayerClient', () => {
  it('erlaubt Operator-konfigurierte Loopback-IP als Risk-Layer-Backend ohne INTERNAL_FETCH_HOSTS', async () => {
    const originalHosts = process.env['INTERNAL_FETCH_HOSTS'];
    const originalNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['INTERNAL_FETCH_HOSTS'];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new RiskLayerClient({
        config: { url: 'http://127.0.0.1:8000', token: config.token },
      });

      const health = await client.health();
      expect(health).toEqual({ ok: true });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://127.0.0.1:8000/v1/health');
      expect(init!.redirect).toBe('error');
      expect((init!.headers as Record<string, string>).authorization).toBe(
        `Bearer ${config.token}`,
      );
    } finally {
      vi.unstubAllGlobals();
      if (originalHosts === undefined) delete process.env['INTERNAL_FETCH_HOSTS'];
      else process.env['INTERNAL_FETCH_HOSTS'] = originalHosts;
      if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('setzt Bearer-Header, ruft den richtigen Pfad und sendet mitLLM:false default', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(analysePayload),
    );
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
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'bad' }, 400),
    );
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

    await expect(client.katalogDefiniere({ begriff: 'b', definition: 'd' })).rejects.toBeInstanceOf(
      RiskLayerHttpError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('katalogReview postet id/status/pruefer und parst den vollständigen Übergang', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        id: 'b1',
        alter_status: 'entwurf',
        neuer_status: 'geprüft',
        pruefer: 's1',
      }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.katalogReview({ id: 'b1', status: 'geprüft', pruefer: 's1' });
    expect(r).toMatchObject({
      ok: true,
      alter_status: 'entwurf',
      neuer_status: 'geprüft',
      pruefer: 's1',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/katalog/review');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      id: 'b1',
      status: 'geprüft',
      pruefer: 's1',
    });
  });

  it('katalogReview wird bei 503 NICHT retried (Schreiben)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}, 503));
    const client = new RiskLayerClient({ config, fetchImpl });

    await expect(client.katalogReview({ id: 'b1', status: 'freigegeben' })).rejects.toBeInstanceOf(
      RiskLayerHttpError,
    );
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

  it('llmStatus liest Verfügbarkeit + Queue (/slots) am richtigen Pfad', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        url: 'http://127.0.0.1:8080',
        verfuegbar: true,
        modell_geladen: true,
        binary_vorhanden: true,
        von_uns_gestartet: true,
        engineVersion: '1.0.0',
        queue: {
          quelle: 'slots',
          slots_gesamt: 4,
          aktiv: 1,
          frei: 3,
          slots: [{ id: 0, aktiv: true }],
        },
      }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const s = await client.llmStatus();
    expect(s.verfuegbar).toBe(true);
    expect(s.queue).toMatchObject({ quelle: 'slots', slots_gesamt: 4, aktiv: 1, frei: 3 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/llm/status');
    expect(init!.method).toBe('GET');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${config.token}`);
  });

  it('llmStatus verkraftet einen nicht laufenden Server (queue=null, verfuegbar default false)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        url: null,
        queue: null,
        binary_vorhanden: true,
        modell_geladen: false,
        von_uns_gestartet: false,
      }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const s = await client.llmStatus();
    expect(s.verfuegbar).toBe(false);
    expect(s.queue).toBeNull();
  });

  it('llmStart postet ohne Body an /v1/llm/start und parst die Antwort', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, hinweis: 'läuft bereits' }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const r = await client.llmStart();
    expect(r).toMatchObject({ ok: true, hinweis: 'läuft bereits' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/llm/start');
    expect(init!.method).toBe('POST');
    expect(init!.body).toBeUndefined(); // kein Request-Input (kein Injection-Vektor)
  });

  it('embeddingStatus parst nur den sicheren Kern und setzt keinen Operator-Header', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        ...embeddingStatusPayload,
        future_top_level: true,
        index: { ...embeddingStatusPayload.index, future_index_field: 'kept' },
      }),
    );
    const client = new RiskLayerClient({ config, fetchImpl });

    const status = await client.embeddingStatus();

    expect(status.index).toMatchObject({ active: true, current: false });
    expect(status.index).not.toHaveProperty('future_index_field');
    expect(status).not.toHaveProperty('future_top_level');
    expect(status.refresh_available).toBe(true);
    expect(
      EmbeddingStatusResponseSchema.parse({
        ...embeddingStatusPayload,
        index: { ...embeddingStatusPayload.index, current: null },
      }).index.current,
    ).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/embedding/status');
    expect(init!.method).toBe('GET');
    expect(init!.headers).not.toHaveProperty('x-risk-layer-operator-token');
  });

  it('embeddingStatus verlangt alle Kernfelder und ISO-Zeitstempel', () => {
    expect(() =>
      EmbeddingStatusResponseSchema.parse({
        ...embeddingStatusPayload,
        index: { ...embeddingStatusPayload.index, revision: undefined },
      }),
    ).toThrow();
    expect(() =>
      EmbeddingStatusResponseSchema.parse({
        ...embeddingStatusPayload,
        job: { ...embeddingStatusPayload.job, requested: 'gestern' },
      }),
    ).toThrow();
    expect(() =>
      EmbeddingStatusResponseSchema.parse({
        ...embeddingStatusPayload,
        index: { ...embeddingStatusPayload.index, fingerprint: 'x'.repeat(513) },
      }),
    ).toThrow();
    expect(() =>
      EmbeddingStatusResponseSchema.parse({
        ...embeddingStatusPayload,
        index: { ...embeddingStatusPayload.index, input_fingerprint: 'not-a-sha256' },
      }),
    ).toThrow();
    expect(() =>
      EmbeddingStatusResponseSchema.parse({
        ...embeddingStatusPayload,
        refresh_available: undefined,
      }),
    ).toThrow();
  });

  it('embeddingRefresh sendet force und das Operator-Secret ausschließlich als Header', async () => {
    const operatorToken = 'operator-token-with-at-least-thirty-two-characters';
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        engineVersion: '1.4.0',
        job_id: 'embedding-123',
        state: 'queued',
      }),
    );
    const client = new RiskLayerClient({ config: { ...config, operatorToken }, fetchImpl });

    await expect(client.embeddingRefresh({ force: true })).resolves.toMatchObject({
      job_id: 'embedding-123',
      state: 'queued',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/embedding/refresh');
    expect((init!.headers as Record<string, string>)['x-risk-layer-operator-token']).toBe(
      operatorToken,
    );
    expect(JSON.parse(init!.body as string)).toEqual({ force: true });
    expect(init!.body).not.toContain(operatorToken);
  });

  it('embeddingSchedule mappt intervalDays auf interval_days', async () => {
    const operatorToken = 'operator-token-with-at-least-thirty-two-characters';
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        engineVersion: '1.4.0',
        schedule: embeddingStatusPayload.schedule,
      }),
    );
    const client = new RiskLayerClient({ config: { ...config, operatorToken }, fetchImpl });

    const result = await client.embeddingSchedule({ enabled: true, intervalDays: 7 });

    expect(result.schedule.interval_days).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://risk-layer:8000/v1/embedding/schedule');
    expect(JSON.parse(init!.body as string)).toEqual({ enabled: true, interval_days: 7 });
    expect((init!.headers as Record<string, string>)['x-risk-layer-operator-token']).toBe(
      operatorToken,
    );
  });

  it.each([
    ['refresh', (client: RiskLayerClient) => client.embeddingRefresh({ force: false })],
    [
      'schedule',
      (client: RiskLayerClient) => client.embeddingSchedule({ enabled: true, intervalDays: 7 }),
    ],
  ])('embedding-%s wird bei 503 nicht wiederholt', async (_name, call) => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}, 503));
    const client = new RiskLayerClient({
      config: { ...config, operatorToken: 'o'.repeat(32) },
      fetchImpl,
    });

    await expect(call(client)).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Operator-Calls scheitern ohne Operator-Secret sicher vor dem Fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}));
    const client = new RiskLayerClient({ config, fetchImpl });

    await expect(client.embeddingRefresh({ force: false })).rejects.toBeInstanceOf(
      RiskLayerOperatorNotConfiguredError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
