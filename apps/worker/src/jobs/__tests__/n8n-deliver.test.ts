// =============================================================================
// Unit-Tests: n8n-deliver-Worker + Outbox-Reconciliation (RF-1).
//
// bullmq via mocks/bullmq.ts (Processor-Capture + Queue.add-Aufzeichnung),
// Prisma/safeFetch/n8n-shared per vi.mock — kein Redis, kein Netzwerk.
// Abgedeckt:
//   - Reconcile reicht stuck PENDING-Reihen mit DETERMINISTISCHER jobId
//     (`outbox-<id>`) neu ein — symmetrisch zum initialen Enqueue, damit eine
//     noch laufende Retry-Kette kein Doppel-POST bekommt (BullMQ-Dedupe)
//   - RF-1: removeOnFail age-basiert, sonst blockiert ein ewiger FAILED-Job
//     jede spätere Re-Zustellung mit derselben jobId
//   - deliver(): Skips (fehlende Reihe, bereits DELIVERED), Whitelist-FAILED,
//     Silent-Skip ohne Konfiguration, Happy-Path mit HMAC-Headern,
//     URL-Encoding des Events (N7), HTTP-Fehler → Retry-Throw,
//     SSRF-Guard → FAILED ohne Retry
//   - failed-Hook: letzter Versuch verbraucht → status=FAILED
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  class SsrfGuardError extends Error {
    constructor(
      public reason: string,
      message: string,
    ) {
      super(message);
      this.name = 'SsrfGuardError';
    }
  }
  const prismaOwner = {
    n8nOutbox: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
  };
  return {
    prismaOwner,
    SsrfGuardError,
    safeFetch: vi.fn(),
    isAllowedN8nEvent: vi.fn(),
    signOutboundN8n: vi.fn(),
    decryptSecret: vi.fn(),
    looksEncrypted: vi.fn(),
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/config', () => ({ env: {}, n8nDeliveryMode: 'production' }));
vi.mock('@taxtronik/n8n-shared', () => ({
  isAllowedN8nEvent: h.isAllowedN8nEvent,
  signOutboundN8n: h.signOutboundN8n,
}));
vi.mock('@taxtronik/crypto', () => ({
  decryptSecret: h.decryptSecret,
  looksEncrypted: h.looksEncrypted,
}));
vi.mock('@taxtronik/http-utils', () => ({
  safeFetch: h.safeFetch,
  SsrfGuardError: h.SsrfGuardError,
}));

import { processors, workerEvents, queueAdds, queueCloses, resetQueueRecords } from './mocks/bullmq';
import '../n8n-deliver';

const FIXED_NOW = new Date('2026-06-09T10:00:00.000Z');
const OUTBOX_ROW = {
  id: 'out-1',
  tenantId: 'tenant-1',
  event: 'document.uploaded',
  payload: { documentId: 'doc-1' },
  occurredAt: new Date('2026-06-09T08:00:00.000Z'),
  status: 'PENDING',
};

function runDeliver(outboxId = 'out-1'): Promise<unknown> {
  return processors.get('n8n-deliver')!({ data: { outboxId } });
}

function runReconcile(): Promise<unknown> {
  return processors.get('n8n-outbox-reconcile')!({ data: {} });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetAllMocks();
  resetQueueRecords();
  h.isAllowedN8nEvent.mockReturnValue(true);
  h.signOutboundN8n.mockReturnValue({ signature: 'sig-1', timestamp: '1780000000', nonce: 'nonce-1' });
  h.looksEncrypted.mockReturnValue(false);
  h.prismaOwner.n8nOutbox.findUnique.mockResolvedValue({ ...OUTBOX_ROW });
  h.prismaOwner.n8nOutbox.update.mockResolvedValue({});
  h.prismaOwner.tenantSetting.findUnique.mockResolvedValue({
    value: { webhookBaseUrl: 'https://n8n.example.com/webhook', hmacSecret: 'topsecret' },
  });
  h.safeFetch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Reconciliation — stuck PENDING-Reihen (RF-1)', () => {
  it('reiht stuck Reihen mit deterministischer jobId `outbox-<id>` neu ein (Dedupe)', async () => {
    h.prismaOwner.n8nOutbox.findMany.mockResolvedValue([{ id: 'out-1' }, { id: 'out-2' }]);

    await runReconcile();

    // nur PENDING älter als 5 min, gedeckelt auf 500
    expect(h.prismaOwner.n8nOutbox.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', createdAt: { lt: new Date(FIXED_NOW.getTime() - 5 * 60_000) } },
      select: { id: true },
      take: 500,
    });

    expect(queueAdds).toHaveLength(2);
    expect(queueAdds[0]).toEqual({
      queue: 'n8n-deliver',
      jobName: 'deliver',
      data: { outboxId: 'out-1' },
      opts: {
        // RF-1: identisch zum initialen Enqueue in apps/web — eine noch
        // laufende Retry-Kette macht dieses add zum No-Op statt Doppel-POST.
        jobId: 'outbox-out-1',
        attempts: 6,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 24 * 60 * 60 },
        // RF-1: age-basiert statt `false` — ein ewig aufgehobener FAILED-Job
        // würde jede spätere Re-Zustellung mit derselben jobId blockieren.
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    });
    expect(queueAdds[1]!.opts.jobId).toBe('outbox-out-2');
    expect(queueCloses).toEqual(['n8n-deliver']);
  });

  it('nichts stuck → kein Enqueue, keine Queue-Verbindung offen', async () => {
    h.prismaOwner.n8nOutbox.findMany.mockResolvedValue([]);

    await runReconcile();

    expect(queueAdds).toHaveLength(0);
    expect(queueCloses).toHaveLength(0);
  });
});

describe('deliver — Skips und Terminal-Zustände', () => {
  it('Outbox-Reihe fehlt → Skip ohne Update/Fetch', async () => {
    h.prismaOwner.n8nOutbox.findUnique.mockResolvedValue(null);

    await runDeliver();

    expect(h.prismaOwner.n8nOutbox.update).not.toHaveBeenCalled();
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('bereits DELIVERED → idempotenter Skip (kein zweiter POST)', async () => {
    h.prismaOwner.n8nOutbox.findUnique.mockResolvedValue({ ...OUTBOX_ROW, status: 'DELIVERED' });

    await runDeliver();

    expect(h.prismaOwner.n8nOutbox.update).not.toHaveBeenCalled();
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('Event nicht in Whitelist → FAILED, kein Versand, kein Retry', async () => {
    h.isAllowedN8nEvent.mockReturnValue(false);

    await runDeliver();

    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenCalledTimes(1);
    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: { status: 'FAILED', lastError: expect.stringContaining('Whitelist') },
    });
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('n8n nicht konfiguriert → Silent-Skip als DELIVERED (kein Retry-Stau)', async () => {
    h.prismaOwner.tenantSetting.findUnique.mockResolvedValue(null); // ENV-Fallback ist leer

    await runDeliver();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenLastCalledWith({
      where: { id: 'out-1' },
      data: {
        status: 'DELIVERED',
        deliveredAt: expect.any(Date),
        lastError: 'n8n nicht konfiguriert (silent skip)',
      },
    });
  });
});

describe('deliver — Happy-Path', () => {
  it('postet signiert an <base>/<event> und markiert DELIVERED', async () => {
    await runDeliver();

    // Versuchszähler vor dem Versand
    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'out-1' },
      data: { attempts: { increment: 1 } },
    });

    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.safeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://n8n.example.com/webhook/document.uploaded');
    expect(init.method).toBe('POST');
    // M-6: kein Auto-Redirect (302 auf interne URL)
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-taxtronik-signature': 'sig-1',
      'x-taxtronik-timestamp': '1780000000',
      'x-taxtronik-nonce': 'nonce-1',
      'x-taxtronik-event': 'document.uploaded',
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      event: 'document.uploaded',
      payload: { documentId: 'doc-1' },
      occurredAt: '2026-06-09T08:00:00.000Z',
      tenantId: 'tenant-1',
    });
    // HMAC über exakt den gesendeten Body, mit dem Tenant-Secret
    expect(h.signOutboundN8n).toHaveBeenCalledWith('document.uploaded', init.body, 'topsecret');

    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenLastCalledWith({
      where: { id: 'out-1' },
      data: { status: 'DELIVERED', deliveredAt: expect.any(Date), lastError: null },
    });
  });

  it('M-7: verschlüsseltes HMAC-Secret wird entschlüsselt verwendet', async () => {
    h.prismaOwner.tenantSetting.findUnique.mockResolvedValue({
      value: { webhookBaseUrl: 'https://n8n.example.com/webhook', hmacEncrypted: 'enc:v1:abc' },
    });
    h.looksEncrypted.mockReturnValue(true);
    h.decryptSecret.mockReturnValue('decrypted-secret');

    await runDeliver();

    expect(h.decryptSecret).toHaveBeenCalledWith('enc:v1:abc');
    expect(h.signOutboundN8n).toHaveBeenCalledWith(
      'document.uploaded',
      expect.any(String),
      'decrypted-secret',
    );
  });

  it('N7: Event wird URL-encodiert — keine Subpath-Injektion', async () => {
    h.prismaOwner.n8nOutbox.findUnique.mockResolvedValue({ ...OUTBOX_ROW, event: 'evil/../path' });

    await runDeliver();

    expect(h.safeFetch.mock.calls[0]![0]).toBe('https://n8n.example.com/webhook/evil%2F..%2Fpath');
  });
});

describe('deliver — Fehlerpfade', () => {
  it('HTTP-Fehler → lastError persistiert + Throw (BullMQ-Retry)', async () => {
    h.safeFetch.mockResolvedValue({ ok: false, status: 502, text: async () => 'Bad Gateway' });

    await expect(runDeliver()).rejects.toThrow('HTTP 502');

    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenLastCalledWith({
      where: { id: 'out-1' },
      data: { lastError: expect.stringContaining('HTTP 502') },
    });
  });

  it('N2: SSRF-Guard → FAILED ohne Throw (kein Retry hilft)', async () => {
    h.safeFetch.mockRejectedValue(new h.SsrfGuardError('private-ip', 'resolves to 10.0.0.1'));

    await runDeliver(); // resolved — kein Retry

    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenLastCalledWith({
      where: { id: 'out-1' },
      data: { status: 'FAILED', lastError: 'SSRF-Guard (private-ip): resolves to 10.0.0.1' },
    });
  });

  it('failed-Hook: letzter Versuch verbraucht → status=FAILED gestempelt', async () => {
    const onFailed = workerEvents.get('n8n-deliver')!.get('failed')!;

    await onFailed(
      { data: { outboxId: 'out-1' }, attemptsMade: 6, opts: { attempts: 6 } },
      new Error('HTTP 502: Bad Gateway'),
    );

    expect(h.prismaOwner.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: { status: 'FAILED', lastError: 'HTTP 502: Bad Gateway' },
    });
  });

  it('failed-Hook: Versuche übrig → KEIN FAILED-Stempel (Retry läuft weiter)', async () => {
    const onFailed = workerEvents.get('n8n-deliver')!.get('failed')!;

    await onFailed(
      { data: { outboxId: 'out-1' }, attemptsMade: 2, opts: { attempts: 6 } },
      new Error('HTTP 502: Bad Gateway'),
    );

    expect(h.prismaOwner.n8nOutbox.update).not.toHaveBeenCalled();
  });
});
