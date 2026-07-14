import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withSystemContext: vi.fn(),
  requestFindMany: vi.fn(),
  requestFindFirst: vi.fn(),
  riskRequestFindFirst: vi.fn(),
  readModules: vi.fn(),
  evidenceRecord: vi.fn(),
  notify: vi.fn(),
  receiveResearchResult: vi.fn(),
  claimReceipt: vi.fn(),
  txRequestFindFirst: vi.fn(),
  contactFindFirst: vi.fn(),
  responseCreate: vi.fn(),
  requestUpdate: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withSystemContext: h.withSystemContext }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    request: { findMany: h.requestFindMany, findFirst: h.requestFindFirst },
    gwgCheck: { findMany: vi.fn() },
    riskResearchRequest: { findFirst: h.riskRequestFindFirst },
  },
}));
vi.mock('@/server/settings/modules', () => ({ readModules: h.readModules }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/notifications/service', () => ({ notify: h.notify }));
vi.mock('@/server/risk', () => ({ receiveResearchResult: h.receiveResearchResult }));
vi.mock('@/server/n8n/callback-receipts', () => ({
  claimN8nCallbackReceipt: h.claimReceipt,
  N8N_CALLBACK_OPERATIONS: {
    inboundMail: 'request-inbound',
    researchResult: 'research-result',
  },
}));

import {
  getOverdueRequestsForTenant,
  getRequestDetailForTenant,
  handleInboundRequestEmail,
} from '../operations';

const TENANT_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const REQUEST_ID = randomUUID();
const CONTACT_ID = randomUUID();
const callbackReceipt = {
  tenantId: TENANT_ID,
  connectionId: CONNECTION_ID,
  requestId: 'delivery-42',
  operation: 'request-inbound' as const,
};
const tx = {
  request: { findFirst: h.txRequestFindFirst, update: h.requestUpdate },
  clientContact: { findFirst: h.contactFindFirst },
  requestResponse: { create: h.responseCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.withSystemContext.mockImplementation(
    async (_tenantId: string, callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  );
  h.readModules.mockResolvedValue({ inboundMail: true });
  h.txRequestFindFirst.mockResolvedValue({
    id: REQUEST_ID,
    title: 'Unterlagen',
    clientId: randomUUID(),
    createdByStaff: randomUUID(),
  });
  h.contactFindFirst.mockResolvedValue({ id: CONTACT_ID });
  h.claimReceipt.mockResolvedValue({ duplicate: false });
  h.responseCreate.mockResolvedValue({ id: randomUUID() });
  h.requestUpdate.mockResolvedValue({ id: REQUEST_ID });
  h.notify.mockResolvedValue(undefined);
  h.evidenceRecord.mockResolvedValue({ id: randomUUID() });
});

describe('n8n operations privacy', () => {
  it('liefert Reminder-Ziele nur aus dem Opt-in-Filter', async () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    h.requestFindMany.mockResolvedValue([
      {
        id: REQUEST_ID,
        tenantId: TENANT_ID,
        title: 'Unterlagen',
        dueAt: new Date('2026-07-12T12:00:00.000Z'),
        client: {
          name: 'Beispiel GmbH',
          contacts: [{ email: 'opt-in@example.test', fullName: 'Opt In' }],
        },
      },
    ]);

    const result = await getOverdueRequestsForTenant(TENANT_ID, now);

    expect(h.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          client: {
            include: {
              contacts: {
                where: { active: true, notificationsEnabled: true, email: { not: '' } },
                take: 1,
                orderBy: { fullName: 'asc' },
              },
            },
          },
        },
      }),
    );
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ signerEmail: 'opt-in@example.test' });
  });

  it('liefert ohne freigegebenen Kontakt kein Reminder-Mailziel', async () => {
    h.requestFindMany.mockResolvedValue([
      {
        id: REQUEST_ID,
        tenantId: TENANT_ID,
        title: 'Unterlagen',
        dueAt: new Date('2026-07-12T12:00:00.000Z'),
        client: { name: 'Beispiel GmbH', contacts: [] },
      },
    ]);

    await expect(
      getOverdueRequestsForTenant(TENANT_ID, new Date('2026-07-14T12:00:00.000Z')),
    ).resolves.toEqual({ count: 0, requests: [] });
  });

  it('gibt in Request-Details nur explizit notifizierbare Kontakte aus', async () => {
    h.requestFindFirst.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: TENANT_ID,
      title: 'Unterlagen',
      description: null,
      priority: 'NORMAL',
      status: 'OPEN',
      dueAt: null,
      client: {
        name: 'Beispiel GmbH',
        contacts: [{ id: CONTACT_ID, fullName: 'Opt In', email: 'opt-in@example.test' }],
      },
    });

    const result = await getRequestDetailForTenant(TENANT_ID, REQUEST_ID);

    expect(h.requestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          client: {
            include: {
              contacts: {
                where: { active: true, notificationsEnabled: true, email: { not: '' } },
                orderBy: { fullName: 'asc' },
              },
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      notifiableContacts: [{ id: CONTACT_ID, fullName: 'Opt In', email: 'opt-in@example.test' }],
    });
    expect(result).not.toHaveProperty('contactName');
    expect(result).not.toHaveProperty('contactEmail');
  });
});

describe('inbound callback transaction idempotency', () => {
  it('claimed den Receipt unmittelbar vor dem ersten Side Effect in derselben Transaktion', async () => {
    const result = await handleInboundRequestEmail(
      TENANT_ID,
      { requestId: REQUEST_ID, fromEmail: 'CLIENT@EXAMPLE.TEST', message: 'Antwort' },
      callbackReceipt,
    );

    expect(result).toEqual({ status: 200, duplicate: false });
    expect(h.claimReceipt).toHaveBeenCalledWith(tx, {
      ...callbackReceipt,
      operation: 'request-inbound',
    });
    expect(h.claimReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      h.responseCreate.mock.invocationCallOrder[0]!,
    );
    expect(h.evidenceRecord).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it('bestätigt einen vorhandenen Receipt ohne erneute Mutation', async () => {
    h.claimReceipt.mockResolvedValue({ duplicate: true, resultId: null });

    await expect(
      handleInboundRequestEmail(
        TENANT_ID,
        { requestId: REQUEST_ID, fromEmail: 'client@example.test', message: 'Antwort' },
        callbackReceipt,
      ),
    ).resolves.toEqual({ status: 200, duplicate: true });

    expect(h.responseCreate).not.toHaveBeenCalled();
    expect(h.requestUpdate).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });
});
