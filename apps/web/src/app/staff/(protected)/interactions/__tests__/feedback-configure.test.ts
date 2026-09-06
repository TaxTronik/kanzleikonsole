// Fachkatalog: CLIENT-FEEDBACK-001, WORKFLOW-LIFECYCLE-001.
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lock: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  invite: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class extends Error {},
  withStaff: async (fn: (tx: unknown, g: unknown) => Promise<void>) => {
    try {
      await fn(
        {
          $queryRaw: h.lock,
          workflowInstance: { findUnique: h.read, update: h.update },
          clientContact: { findFirst: async () => ({ id: 'contact' }) },
        },
        { ctx: {}, session: {}, tenantId: 'tenant', staffId: 'staff' },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
}));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ assertModuleEnabled: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/workflows/interactions', () => ({
  createFeedbackInvitationTx: h.invite,
  noticeDecisionSnapshot: {},
}));
import { configureFeedbackAction } from '../actions';

beforeEach(() => {
  vi.resetAllMocks();
  h.read.mockResolvedValue({ id: 'workflow', clientId: 'client', status: 'ACTIVE' });
});

function input() {
  const data = new FormData();
  data.set('instanceId', '11111111-1111-4111-8111-111111111111');
  data.set('contactId', '22222222-2222-4222-8222-222222222222');
  return data;
}

it('waits for a competing completion before deciding whether to invite or preselect', async () => {
  let lockRequested!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => {
    lockRequested = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.lock.mockImplementation(async () => {
    lockRequested();
    await held;
  });
  const configured = configureFeedbackAction(input());
  await requested;
  expect(h.read).not.toHaveBeenCalled();
  h.read.mockResolvedValue({ id: 'workflow', clientId: 'client', status: 'COMPLETED' });
  release();
  expect(await configured).toEqual({ ok: true });
  expect(h.invite).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    'workflow',
    'contact',
  );
  expect(h.update).not.toHaveBeenCalled();
});

it('preselects a contact while the workflow remains active under the same lock', async () => {
  expect(await configureFeedbackAction(input())).toEqual({ ok: true });
  expect(h.lock).toHaveBeenCalledOnce();
  expect(h.update).toHaveBeenCalledWith({
    where: { id: 'workflow' },
    data: { feedbackContactId: 'contact' },
  });
  expect(h.invite).not.toHaveBeenCalled();
});
