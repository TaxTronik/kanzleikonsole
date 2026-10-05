// Fachkatalog: RISK-AI-SUGGESTION-001
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../bullmq', () => ({
  WEB_QUEUE_TIMEOUT_MS: 2_000,
  getWebQueue: vi.fn(() => ({ add: h.add, remove: h.remove })),
}));
vi.mock('@/server/logger', () => ({ log: h.log }));

import { enqueueRiskAnalyseLlm } from '../risk-analyse-queue';

const sourceText = 'Mandant M verkauft am 1.3. sein Grundstück an die Tochter-GmbH.';

beforeEach(() => {
  vi.clearAllMocks();
  h.add.mockResolvedValue({ id: 'risk-llm-analysis-1' });
  h.remove.mockResolvedValue(1);
});

describe('S-06 risk LLM job payload', () => {
  it('enqueues only tenant, analysis and the hash of the facts, with age-bounded history', async () => {
    await enqueueRiskAnalyseLlm({ tenantId: 'tenant-1', analysisId: 'analysis-1', sourceText });

    expect(h.remove).toHaveBeenCalledWith('risk-llm-analysis-1');
    expect(h.add).toHaveBeenCalledWith(
      'enrich',
      {
        tenantId: 'tenant-1',
        analysisId: 'analysis-1',
        sourceHash: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
      },
      {
        jobId: 'risk-llm-analysis-1',
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 86_400, count: 100 },
        removeOnFail: { age: 604_800, count: 200 },
      },
    );
    expect(JSON.stringify(h.add.mock.calls)).not.toContain('Grundstück');
  });

  it('logs a job that could not be removed and still enqueues idempotently', async () => {
    h.remove.mockRejectedValue(new Error('Job risk-llm-analysis-1 is locked'));

    await enqueueRiskAnalyseLlm({ tenantId: 'tenant-1', analysisId: 'analysis-1', sourceText });

    expect(h.log.warn).toHaveBeenCalledWith(
      {
        component: 'risk-analyse-queue',
        analysisId: 'analysis-1',
        err: 'Job risk-llm-analysis-1 is locked',
      },
      'risk-analyse-queue: vorheriger Job nicht entfernt (läuft noch oder Redis langsam)',
    );
    expect(h.add).toHaveBeenCalledOnce();
  });
});
