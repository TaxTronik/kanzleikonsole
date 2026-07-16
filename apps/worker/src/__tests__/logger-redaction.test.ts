import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from '../logger';

describe('worker logger secret redaction', () => {
  it('redigiert Secrets auf Root- und Objektebene', () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLog = pino(
      { redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' } },
      stream,
    );

    testLog.info({
      token: 'root-secret-token',
      devSignInUrl: 'https://portal.example.test/verify?token=root-secret-token',
      job: { password: 'nested-secret-password', link: 'https://secret.example.test' },
    });

    expect(output).not.toContain('root-secret-token');
    expect(output).not.toContain('nested-secret-password');
    expect(output).not.toContain('secret.example.test');
    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record['token']).toBe('[redacted]');
    expect(record['devSignInUrl']).toBe('[redacted]');
    expect(record['job']).toEqual({ password: '[redacted]', link: '[redacted]' });
  });
});
