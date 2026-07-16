import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    workflowInstance: { findMany: vi.fn() },
    workflowTemplate: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
    formTemplate: { findMany: vi.fn() },
    requestTemplate: { findMany: vi.fn() },
    emailTemplate: { findMany: vi.fn() },
  };
  return { tx };
});

vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, callback: (tx: typeof h.tx) => unknown) =>
    callback(h.tx),
  ),
}));

import { loadClientWorkflows } from '../queries';

describe('loadClientWorkflows query bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tx.workflowInstance.findMany
      .mockResolvedValueOnce([{ id: 'active-1' }])
      .mockResolvedValueOnce([{ id: 'completed-1' }]);
    h.tx.workflowTemplate.findMany.mockResolvedValue([]);
    h.tx.staffUser.findMany.mockResolvedValue([]);
    h.tx.formTemplate.findMany.mockResolvedValue([]);
    h.tx.requestTemplate.findMany.mockResolvedValue([]);
    h.tx.emailTemplate.findMany.mockResolvedValue([]);
  });

  it('lädt laufende Instanzen vollständig und begrenzt das gemeinsame Archiv auf 20', async () => {
    const result = await loadClientWorkflows({} as never, {
      clientId: 'client-1',
      analysisId: 'analysis-1',
      mineStaffId: 'staff-1',
    });

    expect(h.tx.workflowInstance.findMany).toHaveBeenCalledTimes(2);
    const [ongoing, archived] = h.tx.workflowInstance.findMany.mock.calls.map((call) => call[0]);

    expect(ongoing).toMatchObject({
      where: {
        clientId: 'client-1',
        analysisId: 'analysis-1',
        OR: [
          { startedByStaff: 'staff-1' },
          { items: { some: { assigneeStaffId: 'staff-1', doneAt: null } } },
        ],
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
    });
    expect(ongoing).not.toHaveProperty('take');

    expect(archived).toMatchObject({
      where: expect.objectContaining({ status: { in: ['COMPLETED', 'CANCELLED'] } }),
      orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
      take: 20,
    });
    expect(ongoing.include).toBe(archived.include);
    expect(result.instances).toEqual([{ id: 'active-1' }, { id: 'completed-1' }]);
  });
});
