import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    withStaff: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/workflows/execute-step', () => ({ executeWorkflowStep: vi.fn() }));
vi.mock('@/server/db/assert-tenant', () => ({
  assertClientInTenant: vi.fn(),
  assertStaffInTenant: vi.fn(),
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: vi.fn(),
  toActionError: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: h.ActionError,
  staffActionGuard: vi.fn(),
  withStaffModule: () => h.withStaff,
}));

import { addItemToInstanceAction } from '../actions';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function n8nStep(n8nEvent: string) {
  return {
    instanceId: INSTANCE_ID,
    title: 'Automatisierung auslösen',
    kind: 'N8N_TRIGGER' as const,
    config: {},
    n8nEvent,
  };
}

describe('Ad-hoc-Workflow: n8n-Event-Validierung', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withStaff.mockResolvedValue({ ok: true, clientId: 'client-1' });
  });

  it.each([
    ['Slash im Pfad', 'slack/notify'],
    ['Punkt als Sub-Hierarchie', 'slack.notify'],
    ['Großbuchstabe', 'Slack-notify'],
    ['mehr als 41 Zeichen', `a${'b'.repeat(41)}`],
  ])('lehnt %s vor jedem Datenbankzugriff ab', async (_case, n8nEvent) => {
    await expect(addItemToInstanceAction(n8nStep(n8nEvent))).resolves.toEqual({
      ok: false,
      error: 'Validierungsfehler.',
    });

    expect(h.withStaff).not.toHaveBeenCalled();
  });

  it('akzeptiert denselben Whitelist-Suffix wie ein Vorlagen-Schritt', async () => {
    await expect(addItemToInstanceAction(n8nStep('slack_notify-1'))).resolves.toEqual({
      ok: true,
      clientId: 'client-1',
    });

    expect(h.withStaff).toHaveBeenCalledOnce();
  });
});
