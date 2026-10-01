// RISK-ARCHIVE-SNAPSHOT-001 / RISK-AI-SUGGESTION-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ transaction: vi.fn(), record: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.transaction }));
vi.mock('@taxtronik/risk-layer', () => ({ RiskLayerClient: class {} }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn() } }));
import { reanalyzeAnalysis, type ReanalyzeClient } from '../reanalyze';

beforeEach(() => {
  vi.clearAllMocks();
});
const ctx = { tenantId: 'tenant', actorId: 'staff', actorType: 'STAFF' as const };

describe('RISK-ARCHIVE-SNAPSHOT-001 reanalysis post-I/O check', () => {
  it.each(['archived', 'redacted'] as const)(
    'cannot append a result after concurrent %s state',
    async (state) => {
      const current = { id: 'analysis', sourceText: 'source', archivedAt: null as Date | null };
      const tx = {
        $queryRaw: vi.fn(async () => [structuredClone(current)]),
        riskMarking: { findMany: vi.fn(), createMany: vi.fn() },
        riskAnalysis: { update: vi.fn() },
      };
      h.transaction.mockImplementation(async (_ctx, fn) => fn(tx));
      const client = {
        analyse: vi.fn(async () => {
          if (state === 'archived') current.archivedAt = new Date();
          else current.sourceText = '';
          return { markings: [], katalogVersion: 'new', engineVersion: 'new' };
        }),
      } as unknown as ReanalyzeClient;
      await expect(reanalyzeAnalysis(ctx, 'analysis', client)).rejects.toThrow();
      expect(tx.riskMarking.findMany).not.toHaveBeenCalled();
      expect(tx.riskAnalysis.update).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    },
  );
});
