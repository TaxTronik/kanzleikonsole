// K-10: Die Web-App registriert Logger und n8n-Emitter des Mail-Pakets genau
// einmal beim Serverstart (instrumentation.ts) — nicht mehr als Seiteneffekt
// beim Import von @/server/mail/dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  setMailLogger: vi.fn(),
  setN8nEmitter: vi.fn(),
  emitN8nEvent: vi.fn(),
  initializeHardwareAccessPolicy: vi.fn(),
  logRequestError: vi.fn(),
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@taxtronik/mail', () => ({
  setMailLogger: m.setMailLogger,
  setN8nEmitter: m.setN8nEmitter,
}));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/auth/webauthn', () => ({
  initializeHardwareAccessPolicy: m.initializeHardwareAccessPolicy,
}));
vi.mock('@/server/log-request-error', () => ({ logRequestError: m.logRequestError }));

const env = process.env as Record<string, string | undefined>;
const original = { runtime: env['NEXT_RUNTIME'], nodeEnv: env['NODE_ENV'] };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  env['NEXT_RUNTIME'] = original.runtime;
  env['NODE_ENV'] = original.nodeEnv;
});

describe('instrumentation register()', () => {
  it('registriert die Mail-Anbindung in Node genau einmal, auch bei erneutem Aufruf', async () => {
    env['NEXT_RUNTIME'] = 'nodejs';
    env['NODE_ENV'] = 'development';
    const { register } = await import('../instrumentation');

    await register();
    await register();

    expect(m.setN8nEmitter).toHaveBeenCalledOnce();
    expect(m.setN8nEmitter).toHaveBeenCalledWith(m.emitN8nEvent);
    expect(m.setMailLogger).toHaveBeenCalledOnce();
    expect(m.setMailLogger).toHaveBeenCalledWith(m.log);
    // Die Hardware-Policy bleibt der Produktion vorbehalten.
    expect(m.initializeHardwareAccessPolicy).not.toHaveBeenCalled();
  });

  it('registriert in Produktion vor der Hardware-Policy', async () => {
    env['NEXT_RUNTIME'] = 'nodejs';
    env['NODE_ENV'] = 'production';
    const { register } = await import('../instrumentation');

    await register();

    expect(m.setN8nEmitter).toHaveBeenCalledOnce();
    expect(m.initializeHardwareAccessPolicy).toHaveBeenCalledOnce();
    expect(m.setN8nEmitter.mock.invocationCallOrder[0]).toBeLessThan(
      m.initializeHardwareAccessPolicy.mock.invocationCallOrder[0]!,
    );
  });

  it('lässt die Edge-Runtime unberührt', async () => {
    env['NEXT_RUNTIME'] = 'edge';
    const { register } = await import('../instrumentation');

    await register();

    expect(m.setN8nEmitter).not.toHaveBeenCalled();
    expect(m.initializeHardwareAccessPolicy).not.toHaveBeenCalled();
  });

  it('registriert beim bloßen Import der Mail-Re-Exporte nichts mehr', async () => {
    await import('@/server/mail/dispatch');
    await import('@/server/mail/outbox');

    expect(m.setN8nEmitter).not.toHaveBeenCalled();
    expect(m.setMailLogger).not.toHaveBeenCalled();
  });
});

// F-06: unbehandelte Request-Fehler gehen mit Request-ID ins strukturierte Log.
describe('instrumentation onRequestError()', () => {
  const request = { path: '/staff/dashboard', method: 'GET', headers: {} };
  const context = {
    routerKind: 'App Router',
    routePath: '/staff/dashboard',
    routeType: 'render',
    revalidateReason: undefined,
  } as const;

  it('reicht den Fehler in Node an den strukturierten Logger weiter', async () => {
    env['NEXT_RUNTIME'] = 'nodejs';
    const { onRequestError } = await import('../instrumentation');
    const error = new Error('kaputt');

    await onRequestError(error, request, context);

    expect(m.logRequestError).toHaveBeenCalledExactlyOnceWith(error, request, context);
  });

  it('lässt die Edge-Runtime unberührt', async () => {
    env['NEXT_RUNTIME'] = 'edge';
    const { onRequestError } = await import('../instrumentation');

    await onRequestError(new Error('kaputt'), request, context);

    expect(m.logRequestError).not.toHaveBeenCalled();
  });
});
