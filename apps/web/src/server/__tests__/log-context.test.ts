// F-06: Request-ID in jeder Logzeile eines Requests — eigener AsyncLocalStorage
// und der Request-Store, den Next.js für jeden App-Router-Request hält.
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

// Wie der Next-Server (node-environment-baseline): Next legt seine Request-Stores
// nur in einem echten AsyncLocalStorage ab, wenn dieser Global vor dem Laden
// seiner Module existiert; sonst bliebe es bei einem Fake ohne Store.
vi.hoisted(() => {
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
});

vi.mock('@taxtronik/config', () => ({ env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' } }));

import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { currentRequestId, runWithRequestId } from '../log-context';
import { createLogger } from '../logger';

const REQUEST_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const NGINX_REQUEST_ID = '0123456789abcdef0123456789abcdef';

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { log: createLogger(stream), lines };
}

/** Echter Next-Request-Store wie für einen Route Handler (createRequestStoreForAPI). */
function runInNextRequest<T>(headers: Record<string, string>, fn: () => T): T {
  const store = createRequestStoreForAPI(
    { headers } as never,
    { pathname: '/staff/dashboard', search: '' },
    { tags: [], expirationsByCacheKind: new Map() } as never,
    undefined,
    undefined as never,
    undefined,
  );
  return workUnitAsyncStorage.run(store, fn);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('F-06 eigener Request-Kontext', () => {
  it('trägt die Request-ID über await, Timer und parallele Zweige', async () => {
    const { log, lines } = captureLogger();

    await runWithRequestId(REQUEST_ID, async () => {
      log.info('vor dem ersten await');
      await tick();
      await Promise.all([
        (async () => {
          await tick();
          log.info('paralleler Zweig');
        })(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            log.info('Timer');
            resolve();
          }, 1),
        ),
      ]);
      log.info('nach Promise.all');
    });

    expect(lines.map((line) => line['msg'])).toEqual([
      'vor dem ersten await',
      'paralleler Zweig',
      'Timer',
      'nach Promise.all',
    ]);
    expect(lines.every((line) => line['requestId'] === REQUEST_ID)).toBe(true);
  });

  it('trennt gleichzeitige Requests und lässt Zeilen außerhalb ohne ID', async () => {
    const { log, lines } = captureLogger();
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await Promise.all([
      runWithRequestId(REQUEST_ID, async () => {
        await tick();
        log.info('erster');
      }),
      runWithRequestId(other, async () => {
        log.info('zweiter');
        await tick();
        // Verschachtelt gilt der innerste Kontext.
        runWithRequestId(REQUEST_ID, () => log.info('innen'));
      }),
    ]);
    log.info('außerhalb');

    const byMessage = Object.fromEntries(lines.map((line) => [line['msg'], line['requestId']]));
    expect(byMessage).toEqual({
      erster: REQUEST_ID,
      zweiter: other,
      innen: REQUEST_ID,
      außerhalb: undefined,
    });
    expect(currentRequestId()).toBeNull();
  });

  it('lässt ein ausdrücklich geloggtes requestId-Feld gewinnen', () => {
    const { log, lines } = captureLogger();
    runWithRequestId(REQUEST_ID, () => log.info({ requestId: NGINX_REQUEST_ID }, 'explizit'));
    expect(lines[0]?.['requestId']).toBe(NGINX_REQUEST_ID);
  });
});

describe('F-06 Request-Store von Next.js', () => {
  it('liest die vom Proxy gesetzte ID aus dem Request-Store, auch nach await', async () => {
    const { log, lines } = captureLogger();

    await runInNextRequest({ 'x-request-id': REQUEST_ID }, async () => {
      expect(currentRequestId()).toBe(REQUEST_ID);
      await tick();
      log.warn({ component: 'test' }, 'im Route Handler');
    });

    expect(lines[0]).toMatchObject({ requestId: REQUEST_ID, msg: 'im Route Handler' });
  });

  it('übernimmt keine ungeprüften Werte aus dem Store', () => {
    for (const value of ['', 'kunde@example.test', 'abc', `${REQUEST_ID}, ${REQUEST_ID}`]) {
      expect(runInNextRequest({ 'x-request-id': value }, currentRequestId)).toBeNull();
    }
    expect(runInNextRequest({}, currentRequestId)).toBeNull();
  });

  it('bevorzugt einen ausdrücklich gesetzten Kontext', () => {
    const id = runInNextRequest({ 'x-request-id': REQUEST_ID }, () =>
      runWithRequestId(NGINX_REQUEST_ID, currentRequestId),
    );
    expect(id).toBe(NGINX_REQUEST_ID);
  });

  it('liefert für Stores ohne Request (Prerender) keine ID', () => {
    const prerender = { type: 'prerender', phase: 'render' } as never;
    expect(workUnitAsyncStorage.run(prerender, currentRequestId)).toBeNull();
  });
});
