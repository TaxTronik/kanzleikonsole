import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  sendMail: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: h.emitN8nEvent }));
vi.mock('@/server/mail/dispatch', () => ({
  renderTemplate: (template: string) => template,
}));
vi.mock('@/server/mail/send', () => ({ sendMail: h.sendMail }));
vi.mock('@/server/logger', () => ({ log: { error: h.logError } }));

import { executeWorkflowStep } from '../execute-step';

const CLAIMED_AT = expect.any(Date);

function emailItem() {
  return {
    id: 'item-1',
    title: 'Unterlagen senden',
    description: null,
    kind: 'CLIENT_EMAIL',
    config: { subject: 'Betreff', bodyMd: 'Nachricht' },
    n8nEvent: 'email.sent',
    doneAt: null,
    startedAt: null,
    instance: { clientId: 'client-1', name: 'Workflow' },
  };
}

function mockTx() {
  const tx = {
    workflowItem: {
      findUnique: vi.fn().mockResolvedValue(emailItem()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    client: { findUnique: vi.fn().mockResolvedValue({ name: 'Mandant GmbH' }) },
    clientContact: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ email: 'kontakt@example.de', fullName: 'Mara Mandant' }]),
    },
  };
  h.withTenantContext.mockImplementation(
    async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
  );
  return tx;
}

describe('executeWorkflowStep CLIENT_EMAIL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sendMail.mockResolvedValue(undefined);
    h.emitN8nEvent.mockResolvedValue(undefined);
    h.evidenceRecord.mockResolvedValue(undefined);
  });

  it('markiert den Schritt erst nach erfolgreichem Versand als erledigt', async () => {
    const tx = mockTx();

    const result = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      itemId: 'item-1',
    });

    expect(result).toEqual({ ok: true, itemMarkedDone: true });
    expect(tx.workflowItem.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.workflowItem.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: { startedAt: CLAIMED_AT } }),
    );
    expect(tx.workflowItem.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { doneAt: CLAIMED_AT, doneByStaff: 'staff-1' } }),
    );
    expect(h.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(h.emitN8nEvent).toHaveBeenCalledTimes(1);
  });

  it('gibt den Claim bei Versandfehler frei und lässt Schritt sowie Event offen', async () => {
    const tx = mockTx();
    h.sendMail.mockRejectedValueOnce(new Error('smtp down'));

    const result = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      itemId: 'item-1',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Schritt bleibt offen');
    expect(tx.workflowItem.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.workflowItem.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { startedAt: null } }),
    );
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.emitN8nEvent).not.toHaveBeenCalled();
  });
});
