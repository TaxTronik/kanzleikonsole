import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: { status: 'SIGNED', notifications: [] as string[], evidence: [] as string[] },
  candidate: {} as Record<string, unknown>,
  failNotification: false,
  stale: false,
  noRecipients: false,
  lock: vi.fn(),
  update: vi.fn(),
  notify: vi.fn(),
  record: vi.fn(),
  resolve: vi.fn(),
}));
const tx = vi.hoisted(() => ({
  $queryRaw: h.lock,
  powerOfAttorney: {
    findMany: vi.fn(async () => (h.state.status === 'SIGNED' ? [h.candidate] : [])),
    findFirst: vi.fn(),
    updateMany: h.update,
  },
  staffUser: { findMany: vi.fn() },
}));
vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: { tenant: { findMany: vi.fn(async () => [{ id: 'tenant-1' }]) } },
}));
// S-01: Kandidaten und Ablauf laufen über die App-Rolle (withSystemContext).
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (_tenant: string, run: (value: typeof tx) => Promise<unknown>) => {
    const snapshot = structuredClone(h.state);
    try {
      return await run(tx);
    } catch (error) {
      h.state = snapshot;
      throw error;
    }
  },
}));
// R-11: notify(tx, input[]) — je Eingabe ein Schreibversuch auf demselben Tx.
vi.mock('../../notify', () => ({
  notify: async (tx: unknown, input: unknown) => {
    for (const entry of [input].flat()) await h.notify(tx, entry);
    return { created: [input].flat().length, updated: 0 };
  },
}));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolve,
}));
vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: async (_tx: unknown, _tenant: string, ids: string[]) => new Set(ids),
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));

import { processors } from './mocks/bullmq';
import '../poa-expiry-check';

const now = new Date('2026-09-07T10:00:00Z');
const run = () => processors.get('poa-expiry-check')!({ data: { tenantId: 'tenant-1' } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  h.state = { status: 'SIGNED', notifications: [], evidence: [] };
  h.stale = false;
  h.noRecipients = false;
  h.failNotification = false;
  h.candidate = {
    id: 'poa-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    status: 'SIGNED',
    subject: 'Synthetic mandate',
    signerName: 'Testperson',
    validUntil: new Date('2026-09-06T00:00:00Z'),
    client: { name: 'Testmandant', responsibilities: [{ staffId: 'staff-1' }] },
  };
  h.lock.mockResolvedValue([{ id: 'poa-1' }]);
  tx.powerOfAttorney.findFirst.mockImplementation(async () => ({
    ...h.candidate,
    status: h.stale ? 'REVOKED' : h.state.status,
  }));
  tx.staffUser.findMany.mockImplementation(async () => (h.noRecipients ? [] : [{ id: 'admin-1' }]));
  h.update.mockImplementation(async () => {
    if (h.stale) return { count: 0 };
    h.state.status = 'EXPIRED';
    return { count: 1 };
  });
  h.record.mockImplementation(async () => {
    h.state.evidence.push('poa.expire');
  });
  h.notify.mockImplementation(async () => {
    if (h.failNotification) throw new Error('notification-write-failed');
    h.state.notifications.push('notification');
  });
});
afterEach(() => vi.useRealTimers());

describe('POA-LIFECYCLE-001: atomic expiry and notifications', () => {
  it('rolls back expiry and evidence on notification failure, allowing the retry to finish once', async () => {
    h.failNotification = true;
    await expect(run()).rejects.toThrow('notification-write-failed');
    expect(h.state).toEqual({ status: 'SIGNED', notifications: [], evidence: [] });
    h.failNotification = false;
    await run();
    await run();
    expect(h.state).toEqual({
      status: 'EXPIRED',
      notifications: ['notification'],
      evidence: ['poa.expire'],
    });
  });

  it('expires and audits a signed mandate even without any notification recipient', async () => {
    h.noRecipients = true;
    h.candidate.client = { name: 'Testmandant', responsibilities: [] };
    await run();
    expect(h.state).toEqual({ status: 'EXPIRED', notifications: [], evidence: ['poa.expire'] });
  });

  it.each([new Date('2026-09-06T00:00:00Z'), new Date('2026-09-08T00:00:00Z')])(
    'does not publish stale expiry/warning notices after a concurrent revocation (%s)',
    async (validUntil) => {
      h.stale = true;
      h.candidate.validUntil = validUntil;
      await run();
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    },
  );
});
