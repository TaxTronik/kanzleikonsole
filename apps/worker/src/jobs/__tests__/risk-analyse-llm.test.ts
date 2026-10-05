// Fachkatalog: RISK-AI-SUGGESTION-001, RISK-ARCHIVE-SNAPSHOT-001
import { createHash } from 'node:crypto';
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

import { UnrecoverableError } from 'bullmq';
import { processors } from './mocks/bullmq';
import '../risk-analyse-llm';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => {
  vi.resetAllMocks();
  h.moduleEnabled.mockResolvedValue(false);
});

describe('RISK-ARCHIVE-SNAPSHOT-001 / RISK-AI-SUGGESTION-001 queued enrichment', () => {
  const storedText = 'Text source';
  // S-06: the queued job carries no facts, only their hash.
  const payload = { tenantId: 'tenant', analysisId: 'analysis', sourceHash: sha256(storedText) };
  const process = () => processors.get('risk-analyse-llm')!({ data: payload });

  function fixture() {
    const current = {
      id: 'analysis',
      sourceText: storedText,
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
    const { tx, client } = fixture();
    await process();
    expect(client.analyse).toHaveBeenCalledWith({
      text: storedText,
      mitLLM: true,
      optionen: undefined,
    });
    expect(tx.riskAnalysis.update).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(6);
  });

  it('S-06 skips when the stored facts no longer match the queued hash', async () => {
    const { current, tx, client } = fixture();
    current.sourceText = 'Text source (geändert)';
    await process();
    expect(client.analyse).not.toHaveBeenCalled();
    expect(tx.riskAnalysis.update).not.toHaveBeenCalled();
  });

  it('S-06 still processes an in-flight job of the previous version with full text', async () => {
    const { tx, client } = fixture();
    await processors.get('risk-analyse-llm')!({
      data: {
        tenantId: 'tenant',
        analysisId: 'analysis',
        sourceText: storedText,
        optionen: { schwelle: 2 },
      },
    });
    expect(client.analyse).toHaveBeenCalledWith({
      text: storedText,
      mitLLM: true,
      optionen: { schwelle: 2 },
    });
    expect(tx.riskAnalysis.update).toHaveBeenCalledOnce();
  });

  it('S-06 lets a legacy job with outdated text skip like a changed source', async () => {
    const { client } = fixture();
    await processors.get('risk-analyse-llm')!({
      data: { tenantId: 'tenant', analysisId: 'analysis', sourceText: 'älterer Stand' },
    });
    expect(client.analyse).not.toHaveBeenCalled();
  });

  it('S-06 fails a job without hash and text cleanly, without retry', async () => {
    const { client } = fixture();
    const failure = await processors.get('risk-analyse-llm')!({
      data: { tenantId: 'tenant', analysisId: 'analysis' },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toContain('ohne Sachverhalt-Hash');
    expect(h.moduleEnabled).not.toHaveBeenCalled();
    expect(client.analyse).not.toHaveBeenCalled();
  });
});

describe('risk-analyse-llm tenant module gate', () => {
  it('ruft bei deaktiviertem Risk weder Engine noch Datenbank auf', async () => {
    await processors.get('risk-analyse-llm')!({
      data: { tenantId: 'tenant-disabled', analysisId: 'analysis-1', sourceHash: sha256('x') },
    });

    expect(h.moduleEnabled).toHaveBeenCalledWith('tenant-disabled', 'risk');
    expect(h.riskLayerClient).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
  });
});
