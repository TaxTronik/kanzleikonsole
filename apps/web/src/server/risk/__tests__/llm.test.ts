import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/risk-layer', () => ({
  RiskLayerClient: class RiskLayerClient {},
}));

import { getLlmStatus, type LlmStatusClient } from '../llm';

const originalBackend = process.env.RISK_LAYER_LLM_BACKEND;

afterEach(() => {
  if (originalBackend === undefined) delete process.env.RISK_LAYER_LLM_BACKEND;
  else process.env.RISK_LAYER_LLM_BACKEND = originalBackend;
});

function client(status: Awaited<ReturnType<LlmStatusClient['llmStatus']>>): LlmStatusClient {
  return { llmStatus: async () => status };
}

describe('Signal LLM status mapping', () => {
  it('maps the explicit CPU bottleneck reported by Signal', async () => {
    const status = await getLlmStatus(
      client({
        url: 'http://127.0.0.1:8080',
        verfuegbar: false,
        queue: null,
        modell_geladen: true,
        binary_vorhanden: true,
        von_uns_gestartet: false,
        backend: 'cpu',
        performance_bottleneck: true,
      }),
    );

    expect(status).toMatchObject({
      backend: 'cpu',
      performanceBottleneck: true,
      modellGeladen: true,
      binaryVorhanden: true,
    });
  });

  it('uses the managed deployment metadata with an older Signal response', async () => {
    process.env.RISK_LAYER_LLM_BACKEND = 'cpu';
    const status = await getLlmStatus(
      client({
        url: null,
        verfuegbar: false,
        queue: null,
        modell_geladen: true,
        binary_vorhanden: true,
        von_uns_gestartet: false,
      }),
    );

    expect(status.backend).toBe('cpu');
    expect(status.performanceBottleneck).toBe(true);
  });
});
