// F-06: Unbehandelte Request-Fehler (instrumentation.ts → onRequestError) als
// strukturierte Logzeile mit Request-ID, ohne konkreten Pfad samt Query-Token.
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));

vi.mock('@taxtronik/config', () => ({ env: { NODE_ENV: 'production', LOG_LEVEL: 'info' } }));
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>();
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

import { runWithRequestId } from '../log-context';
import { logRequestError } from '../log-request-error';

const REQUEST_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const context = {
  routerKind: 'App Router',
  routePath: '/poa/sign',
  routeType: 'render',
  renderSource: 'react-server-components',
  revalidateReason: undefined,
} as const;

function request(headers: Record<string, string> = {}) {
  return { path: '/poa/sign?token=einmal-token-aus-der-mail', method: 'GET', headers };
}

beforeEach(() => {
  h.lines.length = 0;
});

describe('F-06 logRequestError', () => {
  it('loggt Routenmuster, Fehler und die Request-ID des laufenden Requests', () => {
    const error = Object.assign(new Error('kaputt'), { digest: '12345' });

    runWithRequestId(REQUEST_ID, () => logRequestError(error, request(), context));

    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatchObject({
      level: 50,
      component: 'request-error',
      requestId: REQUEST_ID,
      method: 'GET',
      routePath: '/poa/sign',
      routeType: 'render',
      renderSource: 'react-server-components',
      digest: '12345',
      errName: 'Error',
      err: 'kaputt',
      msg: 'request: unbehandelter Fehler',
    });
    expect(JSON.stringify(h.lines[0])).not.toContain('einmal-token-aus-der-mail');
  });

  it('nimmt außerhalb eines Kontexts die wohlgeformte ID aus den Request-Headern', () => {
    logRequestError(new Error('kaputt'), request({ 'x-request-id': REQUEST_ID }), context);
    expect(h.lines[0]?.['requestId']).toBe(REQUEST_ID);
  });

  it('übernimmt keine fehlerhafte ID aus den Headern', () => {
    logRequestError('kein Error-Objekt', request({ 'x-request-id': 'a@b' }), context);
    expect(h.lines[0]).not.toHaveProperty('requestId');
    expect(h.lines[0]).toMatchObject({ errName: 'string', err: 'kein Error-Objekt' });
  });
});
