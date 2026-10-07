// Fachkatalog: INV-LIFECYCLE-FREEZE-001, AUDIT-HASH-CHAIN-001
// Real invoice actions, Prisma app-role transactions and audit-chain writes.
// Rendering/storage, request authorization and outbound notifications are isolated.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const h = vi.hoisted(() => ({
  tenantId: '',
  staffId: '',
  context: {} as TenantContext,
  run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> => undefined,
  record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => h.run(ctx, run),
}));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({ commitDocumentFromBytes: vi.fn() }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.test' }));
vi.mock('@/server/container', () => ({
  evidenceService: { record: (tx: TxClient, event: AuditEventInput) => h.record(tx, event) },
}));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/documents/upload-helpers', () => ({ createDocumentWithVersion: vi.fn() }));
vi.mock('@/server/documents/storage-compensation', () => ({ compensateStorageCommit: vi.fn() }));
// F-08: Versandaufträge entstehen echt in der App-Rollen-Transaktion; nur der
// Anstoß des Workers (BullMQ) bleibt isoliert.
vi.mock('@/server/mail/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/mail/outbox')>()),
  kickMailOutboxDelivery: vi.fn(),
}));
vi.mock('@/server/invoicing/archive', () => ({
  ensureZugferdArchive: async () => ({ ok: true }),
}));
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ invoiceMode: 'IN_APP' }),
}));
vi.mock('@/server/settings/tenant-settings', () => ({ readSellerInfo: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', async () => {
  const staffActionGuard = async () => ({
    ok: true as const,
    tenantId: h.tenantId,
    staffId: h.staffId,
    ctx: h.context,
    session: {},
  });
  return {
    ActionError: (await import('@/server/actions/action-error')).ActionError,
    staffActionGuard,
    // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
    staffAction: (
      await vi.importActual<typeof import('@/server/actions/action-runner')>(
        '@/server/actions/action-runner',
      )
    ).createActionRunner(staffActionGuard),
    withStaff: async (run: (tx: TxClient, ctx: unknown) => unknown) => {
      try {
        await h.run(h.context, (tx) =>
          run(tx, {
            tenantId: h.tenantId,
            staffId: h.staffId,
            ctx: h.context,
            session: {},
          }),
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    parseFormData: (schema: { parse(input: unknown): unknown }, data: FormData) => ({
      ok: true,
      data: schema.parse(Object.fromEntries(data)),
    }),
  };
});

import { markPaidAction, markSentAction } from '@/app/staff/(protected)/invoices/actions';

// B-02: lokal per INVOICE_CONCURRENCY_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env.INVOICE_CONCURRENCY_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'INVOICE_CONCURRENCY_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`INVOICE_CONCURRENCY_DB_TEST requires a valid ${name}.`);
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error(`INVOICE_CONCURRENCY_DB_TEST requires a PostgreSQL ${name} with a database.`);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
async function backendId(tx: TxClient) {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`;
  return row!.pid;
}
function form(invoiceId: string) {
  const data = new FormData();
  data.set('invoiceId', invoiceId);
  return data;
}

(enabled ? describe : describe.skip)(
  'invoice payment/correction concurrency against PostgreSQL',
  () => {
    const owner = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
    });
    const app = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
    });
    const evidence = new EvidenceService(new LocalTimestampAdapter());
    let clientId: string;
    let onTransaction = async (_tx: TxClient) => {};

    beforeAll(async () => {
      const suffix = randomUUID();
      h.tenantId = (
        await owner.tenant.create({
          data: { slug: `invoice-concurrency-${suffix}`, name: 'Synthetic invoice concurrency' },
        })
      ).id;
      h.staffId = (
        await owner.staffUser.create({
          data: {
            tenantId: h.tenantId,
            email: `${suffix}@example.test`,
            fullName: 'Synthetic staff',
            passwordHash: 'x',
          },
        })
      ).id;
      clientId = (
        await owner.client.create({
          data: {
            tenantId: h.tenantId,
            kind: 'JURPERS',
            name: 'Synthetic client',
            allowActive: false,
            invoiceEmail: `invoices-${suffix}@example.test`,
          },
        })
      ).id;
      await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId: h.tenantId,
        clientId,
        verifiedBy: h.staffId,
        validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
      h.context = { tenantId: h.tenantId, actorId: h.staffId, actorType: 'STAFF' };
      h.run = async (ctx, run) => {
        expect(ctx).toEqual(h.context);
        return app.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8s'");
            await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${h.tenantId},true), set_config('app.current_actor_id',${h.staffId},true), set_config('app.current_actor_type','STAFF',true)`;
            await onTransaction(tx);
            return run(tx);
          },
          { timeout: 12_000 },
        );
      };
    });
    afterAll(async () => {
      // Committed append-only audit rows and fixtures remain in the disposable DB.
      // No evidence/retention trigger is disabled for cleanup.
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    });

    async function makePair() {
      const data = {
        tenantId: h.tenantId,
        clientId,
        subject: 'Synthetic invoice',
        issueDate: new Date('2026-06-01'),
        dueDate: new Date('2026-07-01'),
        format: 'XRECHNUNG' as const,
        netAmount: 100,
        vatAmount: 19,
        totalAmount: 119,
        vatRate: 19,
        createdByStaff: h.staffId,
      };
      const original = await owner.invoice.create({
        data: { ...data, number: `original-${randomUUID()}` },
      });
      await owner.invoice.update({ where: { id: original.id }, data: { status: 'SENT' } });
      const correction = await owner.invoice.create({
        data: {
          ...data,
          number: `correction-${randomUUID()}`,
          stornoOfId: original.id,
          netAmount: -100,
          vatAmount: -19,
          totalAmount: -119,
        },
      });
      return { original, correction };
    }
    async function waitsFor(waiter: number, blocker: number) {
      for (let i = 0; i < 200; i++) {
        const [row] = await owner.$queryRaw<
          Array<{ blockers: number[] }>
        >`SELECT pg_blocking_pids(${waiter}::integer) AS blockers`;
        if (row?.blockers.includes(blocker)) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    }

    it('lets a claimed payment commit before correction without an audit/parent-row deadlock', async () => {
      const { original, correction } = await makePair();
      const paymentReady = deferred<number>();
      const sendReady = deferred<number>();
      const releasePayment = deferred<void>();
      let sendTransactions = 0;
      h.record = async (tx, event) => {
        if (event.action === 'invoice.paid') {
          paymentReady.resolve(await backendId(tx));
          await releasePayment.promise;
        }
        return evidence.record(tx, event);
      };
      const payment = markPaidAction(null, form(original.id));
      // Attach rejection handlers immediately while the controlled interleaving runs.
      const paymentResult = Promise.allSettled([payment]);
      const paymentPid = await paymentReady.promise;
      onTransaction = async (tx) => {
        // markSentAction first reads the draft, then enters the actual send Tx.
        if (++sendTransactions === 2) sendReady.resolve(await backendId(tx));
      };
      const sending = markSentAction(null, form(correction.id));
      const sendResult = Promise.allSettled([sending]);
      let blocked: boolean;
      try {
        blocked = await waitsFor(await sendReady.promise, paymentPid);
      } finally {
        releasePayment.resolve();
      }
      const [paid, sent] = await Promise.all([paymentResult, sendResult]);
      expect(blocked).toBe(true);
      expect(paid[0]).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      expect(
        sent[0],
        sent[0]?.status === 'rejected' ? String(sent[0].reason) : undefined,
      ).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      const stored = await owner.invoice.findUniqueOrThrow({ where: { id: original.id } });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.paidAt).not.toBeNull();
      expect((await owner.invoice.findUniqueOrThrow({ where: { id: correction.id } })).status).toBe(
        'SENT',
      );
      const audit = await owner.auditLog.findMany({
        where: { tenantId: h.tenantId, resourceId: { in: [original.id, correction.id] } },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((event) => event.action)).toEqual([
        'invoice.paid',
        'invoice.send',
        'invoice.cancel',
      ]);
      expect(audit.at(-1)?.after).toMatchObject({ refundDue: true });
      // F-08: die Rechnungsmail liegt als Versandauftrag im Festschreibungs-Commit.
      expect(
        await owner.mailOutbox.findMany({
          where: { tenantId: h.tenantId, resourceType: 'invoice', resourceId: correction.id },
          select: { kind: true, purpose: true, status: true, clientId: true },
        }),
      ).toEqual([{ kind: 'DIRECT', purpose: 'invoice-sent', status: 'QUEUED', clientId }]);
      expect(await owner.$transaction((tx) => evidence.verifyChain(tx, h.tenantId))).toMatchObject({
        ok: true,
        checked: await owner.auditLog.count({ where: { tenantId: h.tenantId } }),
      });
    }, 20_000);

    it('lets a correction holding the original win over a subsequent payment claim', async () => {
      const { original, correction } = await makePair();
      const sendReady = deferred<number>();
      const paymentReady = deferred<number>();
      const releaseSend = deferred<void>();
      onTransaction = async () => {};
      h.record = async (tx, event) => {
        const result = await evidence.record(tx, event);
        if (event.action === 'invoice.send') {
          sendReady.resolve(await backendId(tx));
          await releaseSend.promise;
        }
        return result;
      };
      const sending = markSentAction(null, form(correction.id));
      const sendResult = Promise.allSettled([sending]);
      const sendPid = await sendReady.promise;
      onTransaction = async (tx) => {
        paymentReady.resolve(await backendId(tx));
      };
      const paymentResult = Promise.allSettled([markPaidAction(null, form(original.id))]);
      let blocked: boolean;
      try {
        blocked = await waitsFor(await paymentReady.promise, sendPid);
      } finally {
        releaseSend.resolve();
      }
      const [paid, sent] = await Promise.all([paymentResult, sendResult]);
      expect(blocked).toBe(true);
      expect(
        sent[0],
        sent[0]?.status === 'rejected' ? String(sent[0].reason) : undefined,
      ).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      // Review-Befund F-01: der verlorene Zahlungsclaim kommt als Ergebnis zurück.
      expect(paid[0]).toMatchObject({
        status: 'fulfilled',
        value: { ok: false, error: expect.stringMatching(/Rechnungsstatus hat sich geändert/) },
      });
      const stored = await owner.invoice.findUniqueOrThrow({ where: { id: original.id } });
      expect(stored.status).toBe('CANCELLED');
      expect(stored.paidAt).toBeNull();
      const audit = await owner.auditLog.findMany({
        where: { tenantId: h.tenantId, resourceId: { in: [original.id, correction.id] } },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((event) => event.action)).toEqual(['invoice.send', 'invoice.cancel']);
      expect(audit.at(-1)?.after).toMatchObject({ refundDue: false });
      expect(await owner.$transaction((tx) => evidence.verifyChain(tx, h.tenantId))).toMatchObject({
        ok: true,
        checked: await owner.auditLog.count({ where: { tenantId: h.tenantId } }),
      });
    }, 20_000);
  },
);
