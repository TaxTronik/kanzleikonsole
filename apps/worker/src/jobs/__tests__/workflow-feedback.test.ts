// Fachkatalog: WORKFLOW-LIFECYCLE-001, CLIENT-FEEDBACK-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  candidates: vi.fn(),
  defer: vi.fn(),
  current: vi.fn(),
  feedback: vi.fn(),
  record: vi.fn(),
}));
vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    workflowInstance: { findMany: h.candidates, updateMany: h.defer },
  },
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: vi.fn(async () => []), workflowInstance: { findFirst: h.current } }),
}));
vi.mock('@taxtronik/db/workflow-feedback', () => ({ createWorkflowFeedbackTx: h.feedback }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));
vi.mock('../../logger', () => ({ log: { warn: vi.fn() } }));
import { runWorkflowFeedback } from '../workflow-feedback';
const NOW = new Date('2026-09-06T12:00:00Z');
const candidate = (id: string) => ({ id, tenantId: 'tenant', feedbackPendingAt: NOW });
describe('persistent workflow feedback recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.defer.mockResolvedValue({ count: 1 });
    h.candidates.mockResolvedValue([candidate('first')]);
    h.current.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      startedByStaff: 'creator',
      feedbackContactId: 'contact',
    }));
    h.feedback.mockResolvedValue('INVITED');
  });
  it('ignores a completion already processed or reopened after the scan', async () => {
    h.current.mockResolvedValue(null);
    expect(await runWorkflowFeedback(NOW)).toEqual({ processed: 0, invited: 0, failed: 0 });
    expect(h.feedback).not.toHaveBeenCalled();
    expect(h.defer).not.toHaveBeenCalled();
  });
  it('defers a failed candidate without starving the next completion', async () => {
    h.candidates.mockResolvedValue([candidate('failed'), candidate('healthy')]);
    h.feedback
      .mockRejectedValueOnce(new Error('synthetic transient failure'))
      .mockResolvedValueOnce('INVITED');
    expect(await runWorkflowFeedback(NOW)).toEqual({ processed: 1, invited: 1, failed: 1 });
    expect(h.defer).toHaveBeenCalledWith({
      where: {
        id: 'failed',
        tenantId: 'tenant',
        status: 'COMPLETED',
        feedbackPendingAt: NOW,
        feedbackProcessedAt: null,
      },
      data: { feedbackPendingAt: new Date(NOW.getTime() + 5 * 60_000) },
    });
    expect(h.feedback).toHaveBeenCalledTimes(2);
  });
});
