// Fachkatalog: WORKFLOW-LIFECYCLE-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: vi.fn(),
  moduleEnabled: vi.fn(),
  resume: vi.fn(),
  record: vi.fn(),
  contexts: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: { workflowInstance: { findMany: h.candidates } },
}));
vi.mock('../../module-gate', () => ({ isWorkerTenantModuleEnabled: h.moduleEnabled }));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    h.contexts.push(tenantId);
    return fn({ tenantId });
  },
}));
vi.mock('@taxtronik/db/workflow-lifecycle', () => ({
  resumeElapsedPausedWorkflowTx: h.resume,
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import { runWorkflowAutoResume } from '../workflow-auto-resume';

const NOW = new Date('2026-10-05T08:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.contexts.length = 0;
  h.moduleEnabled.mockResolvedValue(true);
  h.resume.mockImplementation(async (_tx: unknown, input: { instanceId: string }) =>
    input.instanceId === 'changed' ? null : { status: 'ACTIVE', completedAt: null },
  );
});

describe('F-13 workflow-auto-resume job', () => {
  it('selects only elapsed pauses across tenants, bounded per run', async () => {
    h.candidates.mockResolvedValue([]);
    await runWorkflowAutoResume(NOW);
    expect(h.candidates).toHaveBeenCalledWith({
      where: { status: 'PAUSED', pausedUntil: { not: null, lte: NOW } },
      select: { id: true, tenantId: true },
      orderBy: [{ tenantId: 'asc' }, { pausedUntil: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('resumes each instance in its own tenant transaction and audits the actual end state', async () => {
    h.candidates.mockResolvedValue([
      { id: 'a', tenantId: 'tenant-1' },
      { id: 'b', tenantId: 'tenant-2' },
    ]);
    h.resume.mockResolvedValueOnce({ status: 'COMPLETED', completedAt: NOW });

    const result = await runWorkflowAutoResume(NOW);

    expect(h.contexts).toEqual(['tenant-1', 'tenant-2']);
    expect(h.resume).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-1' },
      {
        tenantId: 'tenant-1',
        instanceId: 'a',
        now: NOW,
      },
    );
    expect(h.record).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'tenant-1' },
      {
        tenantId: 'tenant-1',
        actorType: 'SYSTEM',
        actorId: null,
        action: 'workflow.instance.auto_resume',
        resourceType: 'workflow_instance',
        resourceId: 'a',
        after: { status: 'COMPLETED', completedAt: NOW },
      },
    );
    expect(result).toEqual({ due: 2, resumed: 2, unchanged: 0, moduleDisabled: 0, failed: 0 });
  });

  it('neither overwrites nor audits a concurrent extension or cancellation', async () => {
    h.candidates.mockResolvedValue([{ id: 'changed', tenantId: 'tenant-1' }]);
    const result = await runWorkflowAutoResume(NOW);
    expect(h.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resumed: 0, unchanged: 1 });
  });

  it('leaves pauses of tenants with a disabled workflow module untouched', async () => {
    h.candidates.mockResolvedValue([
      { id: 'a', tenantId: 'off' },
      { id: 'b', tenantId: 'off' },
    ]);
    h.moduleEnabled.mockResolvedValue(false);
    const result = await runWorkflowAutoResume(NOW);
    expect(h.moduleEnabled).toHaveBeenCalledTimes(1);
    expect(h.moduleEnabled).toHaveBeenCalledWith('off', 'workflows');
    expect(h.resume).not.toHaveBeenCalled();
    expect(result).toMatchObject({ moduleDisabled: 2, resumed: 0 });
  });

  it('logs a failing instance and still resumes the others', async () => {
    h.candidates.mockResolvedValue([
      { id: 'broken', tenantId: 'tenant-1' },
      { id: 'b', tenantId: 'tenant-1' },
    ]);
    h.resume.mockRejectedValueOnce(new Error('could not serialize access'));

    const result = await runWorkflowAutoResume(NOW);

    expect(result).toMatchObject({ resumed: 1, failed: 1 });
    expect(h.log.error).toHaveBeenCalledWith(
      {
        component: 'workflow-auto-resume',
        tenantId: 'tenant-1',
        workflowId: 'broken',
        err: 'could not serialize access',
      },
      'workflow-auto-resume: Fortsetzen fehlgeschlagen',
    );
  });

  it('is registered as the processor of the workflow-auto-resume queue', async () => {
    h.candidates.mockResolvedValue([]);
    await processors.get('workflow-auto-resume')!({ data: {} });
    expect(h.candidates).toHaveBeenCalledOnce();
  });
});
