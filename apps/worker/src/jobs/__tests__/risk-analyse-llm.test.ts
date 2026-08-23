import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  moduleEnabled: vi.fn(),
  riskLayerClient: vi.fn(),
  withWorkerTenantContext: vi.fn(),
}));

vi.mock('bullmq', async () => {
  const mock = await import('./mocks/bullmq');
  return { ...mock, UnrecoverableError: class UnrecoverableError extends Error {} };
});
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../module-gate', () => ({
  isWorkerTenantModuleEnabled: h.moduleEnabled,
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: h.withWorkerTenantContext,
}));
vi.mock('@taxtronik/risk-layer', () => ({ RiskLayerClient: h.riskLayerClient }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = vi.fn();
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import '../risk-analyse-llm';

beforeEach(() => {
  vi.resetAllMocks();
  h.moduleEnabled.mockResolvedValue(false);
});

describe('risk-analyse-llm tenant module gate', () => {
  it('ruft bei deaktiviertem Risk weder Engine noch Datenbank auf', async () => {
    await processors.get('risk-analyse-llm')!({
      data: {
        tenantId: 'tenant-disabled',
        analysisId: 'analysis-1',
        sourceText: 'Sachverhalt',
        optionen: {},
      },
    });

    expect(h.moduleEnabled).toHaveBeenCalledWith('tenant-disabled', 'risk');
    expect(h.riskLayerClient).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
  });
});
