import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  moduleEnabled: vi.fn(),
  riskLayerClient: vi.fn(),
  withWorkerTenantContext: vi.fn(),
  record: vi.fn(),
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
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import '../risk-analyse-llm';

beforeEach(() => {
  vi.resetAllMocks();
  h.moduleEnabled.mockResolvedValue(false);
});

describe('RISK-ARCHIVE-SNAPSHOT-001 / RISK-AI-SUGGESTION-001 queued enrichment', () => {
  const payload = {
    tenantId: 'tenant',
    analysisId: 'analysis',
    sourceText: 'Text source',
    optionen: {},
  };
  const process = () => processors.get('risk-analyse-llm')!({ data: payload });

  function fixture() {
    const current = {
      id: 'analysis',
      sourceText: payload.sourceText,
      archivedAt: null as Date | null,
    };
    const tx = {
      $queryRaw: vi.fn(async () => [current]),
      riskAnalysis: {
        findFirst: vi.fn(async () => ({ id: 'analysis', markings: [] })),
        update: vi.fn(),
      },
      riskMarking: { createMany: vi.fn() },
    };
    const client = {
      llmStatus: vi.fn(async () => ({ verfuegbar: true })),
      analyse: vi.fn(async () => ({ markings: [], engineVersion: 'test' })),
    };
    h.moduleEnabled.mockResolvedValue(true);
    h.withWorkerTenantContext.mockImplementation(async (_tenant, fn) => fn(tx));
    h.riskLayerClient.mockImplementation(function () {
      return client;
    });
    return { current, tx, client };
  }

  it.each(['archived', 'redacted'] as const)(
    'skips a %s queued source before calling the engine',
    async (state) => {
      const { current, tx, client } = fixture();
      if (state === 'archived') current.archivedAt = new Date();
      else current.sourceText = '';
      await process();
      expect(client.analyse).not.toHaveBeenCalled();
      expect(tx.riskAnalysis.update).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    },
  );

  it.each(['archived', 'redacted'] as const)(
    'discards an engine result when the source became %s during I/O',
    async (state) => {
      const { current, tx, client } = fixture();
      client.analyse.mockImplementation(async () => {
        if (state === 'archived') current.archivedAt = new Date();
        else current.sourceText = '';
        return { markings: [], engineVersion: 'test' };
      });
      await process();
      expect(client.analyse).toHaveBeenCalledOnce();
      expect(tx.riskMarking.createMany).not.toHaveBeenCalled();
      expect(tx.riskAnalysis.update).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    },
  );

  it.each(['archived', 'redacted'] as const)(
    'does not send a source that became %s during model warmup',
    async (state) => {
      const { current, tx, client } = fixture();
      client.llmStatus.mockImplementation(async () => {
        if (state === 'archived') current.archivedAt = new Date();
        else current.sourceText = '';
        return { verfuegbar: true };
      });
      await process();
      expect(client.analyse).not.toHaveBeenCalled();
      expect(tx.riskAnalysis.update).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    },
  );

  it('records successful enrichment only while its source is still writable', async () => {
    const { tx } = fixture();
    await process();
    expect(tx.riskAnalysis.update).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(6);
  });
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
