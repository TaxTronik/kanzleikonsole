// Fachkatalog: WORKFLOW-LIFECYCLE-001, CLIENT-FEEDBACK-001, WORKFLOW-DEPENDENCY-001.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';
import { createWorkflowFeedbackTx } from '../workflow-feedback';
import { lockWorkflowInstanceTx } from '../workflow-lifecycle';

const run = process.env.DATABASE_URL && process.env.DATABASE_APP_URL ? describe : describe.skip;
run('WORKFLOW-LIFECYCLE-001 / CLIENT-FEEDBACK-001 actual database transitions', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId: string, staffId: string;
  const context = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, contactId?: string) =>
    app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true),
        set_config('app.current_actor_id',${contactId ?? staffId},true),
        set_config('app.current_actor_type',${contactId ? 'CLIENT_CONTACT' : 'STAFF'},true)`;
        return fn(tx);
      },
      { timeout: 15000 },
    );
  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    tenantId = (
      await owner.tenant.create({
        data: { slug: `workflow-lifecycle-${suffix}`, name: 'Synthetic lifecycle test' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `lifecycle-${suffix}@example.test`,
          fullName: 'Synthetic admin',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'modules', value: { workflows: true, feedbackSurveys: true } },
    });
  });
  afterAll(async () => {
    if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  async function fixture(count = 2) {
    const client = await owner.client.create({
      data: { tenantId, name: 'Synthetic lifecycle client', kind: 'JURPERS' },
    });
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: client.id,
      verifiedBy: staffId,
      registerNumber: 'HRB-' + crypto.randomUUID(),
    });
    await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });
    const contact = await owner.clientContact.create({
      data: {
        tenantId,
        clientId: client.id,
        email: crypto.randomUUID() + '@example.test',
        fullName: 'Synthetic contact',
      },
    });
    const workflow = await owner.workflowInstance.create({
      data: {
        tenantId,
        clientId: client.id,
        name: 'Synthetic workflow',
        startedByStaff: staffId,
        feedbackContactId: contact.id,
        items: {
          create: Array.from({ length: count }, (_, position) => ({
            title: `Step ${position}`,
            position,
          })),
        },
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    return { client, contact, workflow, items: workflow.items };
  }
  async function waitForBlockedTransaction(pid: number) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const [row] = await owner.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`;
      if (row?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Synthetic concurrent transaction did not block on the workflow lock');
  }
  it('a feedback selection waits for the concurrent last-step completion and invites once', async () => {
    const f = await fixture(1);
    await owner.workflowInstance.update({
      where: { id: f.workflow.id },
      data: { feedbackContactId: null },
    });
    let completed!: () => void, release!: () => void, selectionStarted!: (pid: number) => void;
    const completionWritten = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const releaseCompletion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selectionPid = new Promise<number>((resolve) => {
      selectionStarted = resolve;
    });
    const completion = context(async (tx) => {
      await tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } });
      completed();
      await releaseCompletion;
    });
    await completionWritten;
    let statusRead: string | null = null;
    const selection = context(async (tx) => {
      const [connection] = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;
      selectionStarted(connection!.pid);
      await lockWorkflowInstanceTx(tx, f.workflow.id);
      const workflow = await tx.workflowInstance.findUniqueOrThrow({
        where: { id: f.workflow.id },
      });
      statusRead = workflow.status;
      if (workflow.status === 'COMPLETED') {
        return createWorkflowFeedbackTx(
          tx,
          {
            tenantId,
            staffId,
            instanceId: workflow.id,
            contactId: f.contact.id,
            automatic: false,
          },
          async () => {},
        );
      }
      await tx.workflowInstance.update({
        where: { id: workflow.id },
        data: { feedbackContactId: f.contact.id },
      });
      return 'PRESELECTED';
    });
    let selectionOutcome: string | undefined;
    try {
      await waitForBlockedTransaction(await selectionPid);
      expect(statusRead).toBeNull();
    } finally {
      release();
      [, selectionOutcome] = await Promise.all([completion, selection]);
    }
    expect(selectionOutcome).toBe('INVITED');
    expect(statusRead).toBe('COMPLETED');
    expect(
      await owner.clientInteraction.count({ where: { sourceId: f.workflow.id, kind: 'FEEDBACK' } }),
    ).toBe(1);
  });
  it('a last-step completion waits for the contact selection and keeps its feedback pending', async () => {
    const f = await fixture(1);
    await owner.workflowInstance.update({
      where: { id: f.workflow.id },
      data: { feedbackContactId: null },
    });
    let selected!: () => void, release!: () => void, completionStarted!: (pid: number) => void;
    const selectionRead = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const releaseSelection = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completionPid = new Promise<number>((resolve) => {
      completionStarted = resolve;
    });
    const selection = context(async (tx) => {
      await lockWorkflowInstanceTx(tx, f.workflow.id);
      expect(
        await tx.workflowInstance.findUniqueOrThrow({ where: { id: f.workflow.id } }),
      ).toHaveProperty('status', 'ACTIVE');
      selected();
      await releaseSelection;
      await tx.workflowInstance.update({
        where: { id: f.workflow.id },
        data: { feedbackContactId: f.contact.id },
      });
    });
    await selectionRead;
    const completion = context(async (tx) => {
      const [connection] = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;
      completionStarted(connection!.pid);
      await tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } });
    });
    try {
      await waitForBlockedTransaction(await completionPid);
    } finally {
      release();
      await Promise.all([selection, completion]);
    }
    expect(
      await owner.workflowInstance.findUniqueOrThrow({ where: { id: f.workflow.id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      feedbackContactId: f.contact.id,
      feedbackPendingAt: expect.any(Date),
      feedbackProcessedAt: null,
    });
  });
  it('serializes the final two sibling completions and queues feedback atomically', async () => {
    const f = await fixture();
    await Promise.all(
      f.items.map((item) =>
        context((tx) =>
          tx.workflowItem.update({
            where: { id: item.id },
            data: { doneAt: new Date(), doneByStaff: staffId },
          }),
        ),
      ),
    );
    const completed = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: f.workflow.id },
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.completedAt).not.toBeNull();
    expect(completed.feedbackPendingAt).not.toBeNull();
    await context((tx) =>
      tx.workflowItem.update({
        where: { id: f.items[0]!.id },
        data: { doneAt: null, doneByStaff: null },
      }),
    );
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'ACTIVE', completedAt: null, feedbackPendingAt: null },
    );
  });
  it('a concurrent cancellation survives the late last-item completion', async () => {
    const f = await fixture(1);
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>((r) => {
      locked = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });
    const cancel = context(async (tx) => {
      await tx.workflowInstance.update({
        where: { id: f.workflow.id },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
      locked();
      await released;
    });
    await acquired;
    const done = context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    release();
    await Promise.all([cancel, done]);
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'CANCELLED', feedbackPendingAt: null },
    );
    await expect(
      context((tx) =>
        tx.workflowInstance.update({ where: { id: f.workflow.id }, data: { status: 'COMPLETED' } }),
      ),
    ).rejects.toThrow();
  });
  it('request close completes its last item and its parent, without a web callback', async () => {
    const f = await fixture(1);
    const request = await owner.request.create({
      data: {
        tenantId,
        clientId: f.client.id,
        title: 'Synthetic request',
        description: 'Synthetic request',
        workflowItemId: f.items[0]!.id,
        createdByStaff: staffId,
      },
    });
    await context((tx) =>
      tx.request.update({
        where: { id: request.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedByStaff: staffId },
      }),
    );
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'COMPLETED' },
    );
  });
  it('portal form submission preserves PAUSED and explicit resume reconciles completion', async () => {
    const f = await fixture(1);
    const template = await owner.formTemplate.create({
      data: { tenantId, name: 'Synthetic form', createdByStaff: staffId },
    });
    const submission = await owner.formSubmission.create({
      data: {
        tenantId,
        clientId: f.client.id,
        templateId: template.id,
        workflowItemId: f.items[0]!.id,
        name: 'Synthetic submission',
        createdByStaff: staffId,
      },
    });
    await context((tx) =>
      tx.workflowInstance.update({ where: { id: f.workflow.id }, data: { status: 'PAUSED' } }),
    );
    await context(
      (tx) =>
        tx.formSubmission.update({
          where: { id: submission.id },
          data: { status: 'SUBMITTED', submittedAt: new Date(), submittedByContact: f.contact.id },
        }),
      f.contact.id,
    );
    expect(await owner.workflowItem.findUnique({ where: { id: f.items[0]!.id } })).toHaveProperty(
      'doneAt',
      expect.any(Date),
    );
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'PAUSED', feedbackPendingAt: null },
    );
    await context((tx) =>
      tx.workflowInstance.update({
        where: { id: f.workflow.id },
        data: { status: 'ACTIVE', pausedUntil: null },
      }),
    );
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'COMPLETED', feedbackPendingAt: expect.any(Date) },
    );
  });
  it('exactly one invitation survives parallel dispatch, retries and recompletion', async () => {
    const f = await fixture(1);
    await context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    const invite = () =>
      context((tx) =>
        createWorkflowFeedbackTx(
          tx,
          {
            tenantId,
            staffId,
            instanceId: f.workflow.id,
            contactId: f.contact.id,
            automatic: true,
          },
          async () => {},
        ),
      );
    expect((await Promise.all([invite(), invite()])).sort()).toEqual([
      'ALREADY_INVITED',
      'INVITED',
    ]);
    expect(
      await owner.clientInteraction.count({
        where: { tenantId, sourceId: f.workflow.id, kind: 'FEEDBACK' },
      }),
    ).toBe(1);
    expect(
      await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } }),
    ).toHaveProperty('feedbackProcessedAt', expect.any(Date));
    await context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: null } }),
    );
    await context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    expect(
      await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } }),
    ).toHaveProperty('feedbackPendingAt', null);
  });
  it('an inactive designated contact is processed without preventing completion', async () => {
    const f = await fixture(1);
    await owner.clientContact.update({ where: { id: f.contact.id }, data: { active: false } });
    await context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    expect(
      await context((tx) =>
        createWorkflowFeedbackTx(
          tx,
          {
            tenantId,
            staffId,
            instanceId: f.workflow.id,
            contactId: f.contact.id,
            automatic: true,
          },
          async () => {},
        ),
      ),
    ).toBe('CONTACT_UNAVAILABLE');
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'COMPLETED', feedbackProcessedAt: expect.any(Date) },
    );
  });
  it('an evidence failure rolls back the invitation and leaves its dispatch retryable', async () => {
    const f = await fixture(1);
    await context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    await expect(
      context((tx) =>
        createWorkflowFeedbackTx(
          tx,
          {
            tenantId,
            staffId,
            instanceId: f.workflow.id,
            contactId: f.contact.id,
            automatic: true,
          },
          async () => {
            throw new Error('synthetic evidence failure');
          },
        ),
      ),
    ).rejects.toThrow('synthetic evidence failure');
    expect(
      await owner.clientInteraction.count({ where: { tenantId, sourceId: f.workflow.id } }),
    ).toBe(0);
    expect(await owner.workflowInstance.findUnique({ where: { id: f.workflow.id } })).toMatchObject(
      { status: 'COMPLETED', feedbackProcessedAt: null, feedbackPendingAt: expect.any(Date) },
    );
  });
  it('the 90-day interval skips and processes a second completed milestone', async () => {
    const f = await fixture(1);
    await context((tx) =>
      tx.workflowItem.update({ where: { id: f.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    await context((tx) =>
      createWorkflowFeedbackTx(
        tx,
        { tenantId, staffId, instanceId: f.workflow.id, contactId: f.contact.id, automatic: true },
        async () => {},
      ),
    );
    const second = await owner.workflowInstance.create({
      data: {
        tenantId,
        clientId: f.client.id,
        name: 'Second milestone',
        startedByStaff: staffId,
        feedbackContactId: f.contact.id,
        items: { create: { title: 'Final step', position: 0 } },
      },
      include: { items: true },
    });
    await context((tx) =>
      tx.workflowItem.update({ where: { id: second.items[0]!.id }, data: { doneAt: new Date() } }),
    );
    expect(
      await context((tx) =>
        createWorkflowFeedbackTx(
          tx,
          { tenantId, staffId, instanceId: second.id, contactId: f.contact.id, automatic: true },
          async () => {},
        ),
      ),
    ).toBe('INTERVAL');
    expect(await owner.workflowInstance.findUnique({ where: { id: second.id } })).toMatchObject({
      status: 'COMPLETED',
      feedbackProcessedAt: expect.any(Date),
    });
  });
});
