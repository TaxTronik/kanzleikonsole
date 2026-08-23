import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  sendMail: vi.fn(),
  logError: vi.fn(),
  readBooleanTenantModules: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: h.withTenantContext,
  readBooleanTenantModules: h.readBooleanTenantModules,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: h.emitN8nEvent }));
vi.mock('@/server/mail/dispatch', () => ({
  renderTemplate: (template: string) => template,
}));
vi.mock('@/server/mail/send', () => ({ sendMail: h.sendMail }));
vi.mock('@/server/logger', () => ({ log: { error: h.logError } }));

import { executeWorkflowStep } from '../execute-step';

type Item = ReturnType<typeof emailItem>;
type Recipient = {
  id: string;
  itemId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  claimedAt: Date | null;
  sentAt: Date | null;
  attemptCount: number;
  lastError: string | null;
};
type RecipientSnapshot = Omit<
  Recipient,
  'id' | 'claimedAt' | 'sentAt' | 'attemptCount' | 'lastError'
>;
type WorkflowItemUpdateArgs = {
  where?: {
    startedAt?: Date | null;
    OR?: Array<{ startedAt?: null | { lte?: Date } }>;
  };
  data: { startedAt?: Date | null; doneAt?: Date };
};
type RecipientWhere = {
  id?: string;
  itemId?: string;
  sentAt?: null;
  claimedAt?: Date;
  OR?: Array<{ claimedAt?: null | { lte?: Date } }>;
};
type RecipientUpdateArgs = {
  where?: RecipientWhere;
  data: {
    claimedAt?: Date | null;
    sentAt?: Date;
    lastError?: string | null;
    attemptCount?: { increment: number };
  };
};
type Dispatch = {
  id: string;
  itemId: string;
  tenantId: string;
  actorStaffId: string;
  event: string;
  payload: Record<string, unknown>;
  enqueuedAt: Date | null;
};

function emailItem() {
  return {
    id: 'item-1',
    title: 'Unterlagen senden',
    description: null as string | null,
    kind: 'CLIENT_EMAIL',
    config: { subject: 'Betreff', bodyMd: 'Nachricht' } as Record<string, unknown>,
    n8nEvent: 'email.sent' as string | null,
    doneAt: null as Date | null,
    startedAt: null as Date | null,
    instance: { clientId: 'client-1', name: 'Workflow' },
  };
}

function dateMatches(actual: Date | null, expected: unknown): boolean {
  return expected instanceof Date && actual?.getTime() === expected.getTime();
}

function recipientMatchesWhere(recipient: Recipient, where: RecipientWhere): boolean {
  if (where.id && recipient.id !== where.id) return false;
  if (where.itemId && recipient.itemId !== where.itemId) return false;
  if (where.sentAt === null && recipient.sentAt !== null) return false;
  if (where.claimedAt instanceof Date && !dateMatches(recipient.claimedAt, where.claimedAt)) {
    return false;
  }
  if (!where.OR) return true;

  const staleBefore = where.OR[1]?.claimedAt?.lte as Date | undefined;
  return !recipient.claimedAt || Boolean(staleBefore && recipient.claimedAt <= staleBefore);
}

function applyRecipientUpdate(recipient: Recipient, data: RecipientUpdateArgs['data']): void {
  if (data.claimedAt !== undefined) recipient.claimedAt = data.claimedAt;
  if (data.sentAt) recipient.sentAt = data.sentAt;
  if (data.lastError !== undefined) recipient.lastError = data.lastError;
  if (data.attemptCount?.increment) recipient.attemptCount += 1;
}

function makeTx(
  input: {
    item?: Item;
    contacts?: Array<{ email: string; fullName: string }>;
  } = {},
) {
  const item = input.item ?? emailItem();
  const recipients: Recipient[] = [];
  let recipientSeq = 0;
  const requests: Array<Record<string, unknown>> = [];
  let dispatch: Dispatch | null = null;

  const tx = {
    workflowItem: {
      findUnique: vi.fn().mockImplementation(async () => ({ ...item })),
      updateMany: vi.fn().mockImplementation(async (args: WorkflowItemUpdateArgs) => {
        if (item.doneAt) return { count: 0 };
        const where = args.where ?? {};
        if (where.startedAt === null && item.startedAt !== null) return { count: 0 };
        if (where.startedAt instanceof Date && !dateMatches(item.startedAt, where.startedAt)) {
          return { count: 0 };
        }
        if (where.OR) {
          const staleBefore = where.OR[1]?.startedAt?.lte as Date | undefined;
          if (item.startedAt && (!staleBefore || item.startedAt > staleBefore)) return { count: 0 };
        }
        if (args.data.startedAt !== undefined) item.startedAt = args.data.startedAt;
        if (args.data.doneAt) item.doneAt = args.data.doneAt;
        return { count: 1 };
      }),
    },
    workflowEmailRecipient: {
      count: vi.fn().mockImplementation(async (args?: { where?: { sentAt?: null } }) => {
        const pendingOnly = args?.where?.sentAt === null;
        return recipients.filter((recipient) => !pendingOnly || recipient.sentAt === null).length;
      }),
      createMany: vi.fn().mockImplementation(async (args: { data: RecipientSnapshot[] }) => {
        for (const row of args.data) {
          if (
            recipients.some(
              (recipient) =>
                recipient.itemId === row.itemId &&
                recipient.recipientEmail.toLowerCase() === row.recipientEmail.toLowerCase(),
            )
          ) {
            continue;
          }
          recipientSeq += 1;
          recipients.push({
            id: `recipient-${recipientSeq}`,
            ...row,
            claimedAt: null,
            sentAt: null,
            attemptCount: 0,
            lastError: null,
          });
        }
        return { count: recipients.length };
      }),
      updateMany: vi.fn().mockImplementation(async (args: RecipientUpdateArgs) => {
        let count = 0;
        for (const recipient of recipients) {
          const where = args.where ?? {};
          if (!recipientMatchesWhere(recipient, where)) continue;
          applyRecipientUpdate(recipient, args.data);
          count += 1;
        }
        return { count };
      }),
      findMany: vi.fn().mockImplementation(async (args: { where: RecipientWhere }) =>
        recipients
          .filter(
            (recipient) =>
              recipient.itemId === args.where.itemId &&
              recipient.sentAt === null &&
              dateMatches(recipient.claimedAt, args.where.claimedAt),
          )
          .map((recipient) => ({
            id: recipient.id,
            recipientEmail: recipient.recipientEmail,
            subject: recipient.subject,
            bodyText: recipient.bodyText,
            bodyHtml: recipient.bodyHtml,
          })),
      ),
    },
    workflowN8nDispatch: {
      findUnique: vi.fn().mockImplementation(async () =>
        dispatch
          ? {
              id: dispatch.id,
              actorStaffId: dispatch.actorStaffId,
              event: dispatch.event,
              payload: dispatch.payload,
            }
          : null,
      ),
      create: vi
        .fn()
        .mockImplementation(async (args: { data: Omit<Dispatch, 'id' | 'enqueuedAt'> }) => {
          const created = {
            id: 'dispatch-1',
            ...args.data,
            enqueuedAt: null,
          };
          dispatch = created;
          return {
            id: created.id,
            actorStaffId: created.actorStaffId,
            event: created.event,
            payload: created.payload,
          };
        }),
      updateMany: vi
        .fn()
        .mockImplementation(
          async (args: { where: { id: string }; data: { enqueuedAt?: Date | null } }) => {
            if (!dispatch || dispatch.id !== args.where.id || dispatch.enqueuedAt)
              return { count: 0 };
            if (args.data.enqueuedAt) dispatch.enqueuedAt = args.data.enqueuedAt;
            return { count: 1 };
          },
        ),
    },
    emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    client: { findUnique: vi.fn().mockResolvedValue({ name: 'Mandant GmbH' }) },
    clientContact: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          input.contacts ?? [{ email: 'kontakt@example.de', fullName: 'Mara Mandant' }],
        ),
    },
    requestTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    formTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    formSubmission: { create: vi.fn(), update: vi.fn() },
    request: {
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `request-${requests.length + 1}`, ...args.data };
        requests.push(row);
        return row;
      }),
    },
  };
  h.withTenantContext.mockImplementation(
    async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
  );
  return { tx, item, recipients, requests };
}

describe('executeWorkflowStep consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sendMail.mockResolvedValue(undefined);
    h.emitN8nEvent.mockResolvedValue({
      eventId: 'outbox-1',
      status: 'PENDING',
      deliveryCount: 1,
    });
    h.evidenceRecord.mockResolvedValue(undefined);
    h.readBooleanTenantModules.mockResolvedValue({ workflows: true, forms: true });
  });

  it('mutiert beim direkten Service-Aufruf nichts, wenn Workflows deaktiviert sind', async () => {
    const { tx } = makeTx();
    h.readBooleanTenantModules.mockResolvedValue({ workflows: false, forms: true });

    await expect(
      executeWorkflowStep({ tenantId: 'tenant-1', staffId: 'staff-1', itemId: 'item-1' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Workflow-Modul') });

    expect(tx.workflowItem.findUnique).not.toHaveBeenCalled();
  });

  it('beansprucht keinen CLIENT_FORM-Schritt, wenn Formulare deaktiviert sind', async () => {
    const { tx } = makeTx({ item: { ...emailItem(), kind: 'CLIENT_FORM' } });
    h.readBooleanTenantModules.mockResolvedValue({ workflows: true, forms: false });

    await expect(
      executeWorkflowStep({ tenantId: 'tenant-1', staffId: 'staff-1', itemId: 'item-1' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Formular-Modul') });

    expect(tx.workflowItem.updateMany).not.toHaveBeenCalled();
  });

  it('markiert CLIENT_EMAIL erst nach persistierter Empfängerbestätigung als erledigt', async () => {
    const { item, recipients } = makeTx();
    const result = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      itemId: 'item-1',
    });
    expect(result).toEqual({ ok: true, itemMarkedDone: true });
    expect(item.doneAt).toBeInstanceOf(Date);
    expect(recipients).toMatchObject([
      { recipientEmail: 'kontakt@example.de', sentAt: expect.any(Date) },
    ]);
    expect(h.evidenceRecord).toHaveBeenCalledOnce();
    expect(h.emitN8nEvent).toHaveBeenCalledOnce();
  });

  it('sendet nach Teilfehler beim Retry nur an den noch offenen Empfänger', async () => {
    const { item, recipients } = makeTx({
      contacts: [
        { email: 'erfolg@example.de', fullName: 'Erfolg' },
        { email: 'retry@example.de', fullName: 'Retry' },
      ],
    });
    let retryAttempts = 0;
    h.sendMail.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'retry@example.de' && retryAttempts++ === 0) throw new Error('smtp down');
    });
    const first = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      itemId: 'item-1',
    });
    expect(first.ok).toBe(false);
    expect(item.startedAt).toBeNull();
    expect(
      recipients.find((row) => row.recipientEmail === 'erfolg@example.de')?.sentAt,
    ).toBeInstanceOf(Date);
    expect(recipients.find((row) => row.recipientEmail === 'retry@example.de')?.sentAt).toBeNull();

    const second = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      itemId: 'item-1',
    });
    expect(second).toEqual({ ok: true, itemMarkedDone: true });
    expect(h.sendMail.mock.calls.filter(([mail]) => mail.to === 'erfolg@example.de')).toHaveLength(
      1,
    );
    expect(h.sendMail.mock.calls.filter(([mail]) => mail.to === 'retry@example.de')).toHaveLength(
      2,
    );
  });

  it('lässt N8N_TRIGGER bei WRITE_FAILED offen und retrybar', async () => {
    const item = {
      ...emailItem(),
      kind: 'N8N_TRIGGER',
      config: { payload: { source: 'test' } },
      n8nEvent: 'custom.trigger',
    };
    const { item: state, tx } = makeTx({ item });
    h.emitN8nEvent.mockResolvedValueOnce({
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'outbox down',
    });
    const first = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      itemId: 'item-1',
    });
    expect(first).toEqual({ ok: false, error: 'outbox down' });
    expect(state.doneAt).toBeNull();
    expect(state.startedAt).toBeNull();
    expect(h.evidenceRecord).not.toHaveBeenCalled();

    const retry = await executeWorkflowStep({
      tenantId: 'tenant-1',
      staffId: 'staff-2',
      itemId: 'item-1',
    });
    expect(retry).toEqual({ ok: true, itemMarkedDone: true });
    expect(state.doneAt).toBeInstanceOf(Date);
    expect(h.evidenceRecord).toHaveBeenCalledOnce();
    expect(tx.workflowN8nDispatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorStaffId: 'staff-1' }),
      }),
    );
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      // Der zweite Klick darf den Actor der bereits dauerhaften Absicht nicht umdeuten.
      expect.objectContaining({ actorType: 'STAFF', actorId: 'staff-1' }),
    );
  });

  it('lässt unter parallelem TASK-Doppelaufruf nur einen CAS-Gewinner zu', async () => {
    const item = { ...emailItem(), kind: 'TASK', config: {}, n8nEvent: null };
    makeTx({ item });
    const results = await Promise.all([
      executeWorkflowStep({ tenantId: 'tenant-1', staffId: 'staff-1', itemId: 'item-1' }),
      executeWorkflowStep({ tenantId: 'tenant-1', staffId: 'staff-1', itemId: 'item-1' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(h.evidenceRecord).toHaveBeenCalledOnce();
  });

  it('erzeugt unter parallelem CLIENT_REQUEST-Doppelaufruf nur ein Artefakt', async () => {
    const item = {
      ...emailItem(),
      kind: 'CLIENT_REQUEST',
      config: { requestTitle: 'Unterlagen', requestDescription: 'Bitte senden' },
      n8nEvent: null,
    };
    const { requests } = makeTx({ item });
    const results = await Promise.all([
      executeWorkflowStep({ tenantId: 'tenant-1', staffId: 'staff-1', itemId: 'item-1' }),
      executeWorkflowStep({ tenantId: 'tenant-1', staffId: 'staff-1', itemId: 'item-1' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(h.evidenceRecord).toHaveBeenCalledOnce();
  });
});
