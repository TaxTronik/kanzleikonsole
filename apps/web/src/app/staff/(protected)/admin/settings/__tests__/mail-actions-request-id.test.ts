// F-06: Eine echte Server Action schreibt ihre Logzeilen mit der Request-ID, die
// der Proxy dem Request gegeben hat — auch nach mehreren awaits (Gate,
// SMTP-Konfiguration, Versandversuch). Next.js führt Server Actions im
// Request-Store der Seite aus; der Test nutzt dessen echte Fabrik.
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // Wie der Next-Server: echter AsyncLocalStorage für die Request-Stores.
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  return {
    lines: [] as Array<Record<string, unknown>>,
    staffActionGuard: vi.fn(),
    readSmtpConfig: vi.fn(),
    sendTestMail: vi.fn(),
  };
});

vi.mock('@taxtronik/config', () => ({ env: { NODE_ENV: 'production', LOG_LEVEL: 'info' } }));
vi.mock('@/server/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/logger')>();
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        h.lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { ...actual, log: actual.createLogger(stream) };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/actions/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/settings/mail-dispatch', () => ({ writeMailDispatchTx: vi.fn() }));
vi.mock('@/server/settings/smtp', () => ({
  readSmtpConfig: h.readSmtpConfig,
  writeSmtpConfigTx: vi.fn(),
  deleteSmtpConfigTx: vi.fn(),
}));
vi.mock('@/server/mail/send', () => ({ sendTestMail: h.sendTestMail }));
vi.mock('@/server/actions/staff-action', async () => ({
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(h.staffActionGuard),
}));

import { createRequestStoreForRender } from 'next/dist/server/async-storage/request-store';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { sendTestMailAction } from '../mail-actions';

const REQUEST_ID = '6c1d0e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

function testMailForm(): FormData {
  const form = new FormData();
  form.set('host', 'smtp.example.test');
  form.set('port', '587');
  form.set('from', 'kanzlei@example.test');
  form.set('testTo', 'admin@example.test');
  form.set('keepPassword', 'on');
  return form;
}

/** Request-Store der Seite wie für eine Server Action (Phase `action`). */
function runAsServerAction<T>(headers: Record<string, string>, fn: () => Promise<T>) {
  const store = createRequestStoreForRender(
    { headers } as never,
    undefined,
    { pathname: '/staff/admin/settings/mail', search: '' },
    {},
    { tags: [], expirationsByCacheKind: new Map() } as never,
    undefined,
    undefined as never,
    false,
    undefined,
    null,
    null,
    undefined,
  );
  store.phase = 'action';
  return workUnitAsyncStorage.run(store, fn);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.lines.length = 0;
  h.staffActionGuard.mockImplementation(async () => {
    await Promise.resolve();
    return {
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    };
  });
  h.readSmtpConfig.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { password: 'x'.repeat(12) };
  });
  h.sendTestMail.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
  });
});

describe('F-06 Request-ID in einer Server Action', () => {
  it('trägt die Request-ID des Requests in die Logzeile nach mehreren awaits', async () => {
    const result = await runAsServerAction({ 'x-request-id': REQUEST_ID }, () =>
      sendTestMailAction(null, testMailForm()),
    );

    expect(result).toMatchObject({ ok: false });
    expect(h.readSmtpConfig).toHaveBeenCalledOnce();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatchObject({
      requestId: REQUEST_ID,
      component: 'smtp-test',
      code: 'ECONNECTION',
      msg: 'SMTP-Test fehlgeschlagen',
    });
  });

  it('schreibt ohne Request keine Request-ID', async () => {
    await sendTestMailAction(null, testMailForm());

    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).not.toHaveProperty('requestId');
  });
});
