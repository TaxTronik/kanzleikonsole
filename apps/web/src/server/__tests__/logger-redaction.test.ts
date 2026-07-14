import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/config', () => ({
  env: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
}));

import { LOG_REDACT_PATHS } from '../logger';

describe('logger secret redaction', () => {
  it('redigiert Magic-Link-URLs auf Root- und Objektebene', () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLog = pino({ redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' } }, stream);
    const rawUrl = 'https://portal.example.test/verify?token=raw-one-time-token';

    testLog.info({
      devSignInUrl: rawUrl,
      link: rawUrl,
      mail: { link: rawUrl, token: 'nested-secret-token' },
    });

    expect(output).not.toContain('raw-one-time-token');
    expect(output).not.toContain('nested-secret-token');
    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record['devSignInUrl']).toBe('[redacted]');
    expect(record['link']).toBe('[redacted]');
    expect(record['mail']).toEqual({ link: '[redacted]', token: '[redacted]' });
  });
});
