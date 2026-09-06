// Fachkatalog: WORKFLOW-LIFECYCLE-001.
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  readAfter: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => Promise<void>) =>
    fn({
      workflowInstance: {
        findMany: h.findMany,
        updateMany: h.updateMany,
        findUniqueOrThrow: h.readAfter,
      },
    }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
import { autoResumePausedWorkflows } from '../auto-resume';
beforeEach(() => {
  vi.clearAllMocks();
  h.findMany.mockResolvedValue([{ id: 'changed' }, { id: 'ready' }]);
  h.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
  h.readAfter.mockResolvedValue({ status: 'ACTIVE', completedAt: null });
});
it('records the actual completion when late answers finished every paused step', async () => {
  const completedAt = new Date('2026-09-06T12:00:00Z');
  h.readAfter.mockResolvedValue({ status: 'COMPLETED', completedAt });
  await autoResumePausedWorkflows('tenant', 'staff');
  expect(h.record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ resourceId: 'ready', after: { status: 'COMPLETED', completedAt } }),
  );
});
it('does not overwrite or audit a concurrent cancellation or extended pause', async () => {
  await autoResumePausedWorkflows('tenant', 'staff');
  expect(h.updateMany).toHaveBeenCalledWith({
    where: {
      id: 'changed',
      status: 'PAUSED',
      pausedUntil: {
        not: null,
        lte: expect.any(Date),
      },
    },
    data: { status: 'ACTIVE', pausedUntil: null },
  });
  expect(h.record).toHaveBeenCalledTimes(1);
  expect(h.record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ resourceId: 'ready' }),
  );
});
