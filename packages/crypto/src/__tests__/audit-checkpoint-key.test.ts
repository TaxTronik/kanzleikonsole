// Fachkatalog: AUDIT-VERIFY-ALERT-001
// Schlüssel der HMAC-Prüfsumme für Prüf-Checkpoints der Audit-Kettenprüfung:
// HKDF aus dem vorhandenen Worker-Geheimnis mit eigenem Info-Label.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { hkdfSync } from 'node:crypto';

const { TEST_SECRET } = vi.hoisted(() => ({
  TEST_SECRET: 'unit-test-auth-secret-with-at-least-32-chars',
}));

vi.mock('@taxtronik/config', () => ({
  env: { AUTH_SECRET: TEST_SECRET, SECRET_BOX_KEY: undefined },
}));

import { deriveAuditCheckpointMacKey } from '../index';
import { env } from '@taxtronik/config';

type MockEnv = { AUTH_SECRET: string; SECRET_BOX_KEY: string | undefined };
const SALT = Buffer.from('taxtronik-secret-box-v2-salt', 'utf8');

function expected(ikm: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, SALT, Buffer.from(info, 'utf8'), 32));
}

afterEach(() => {
  (env as MockEnv).AUTH_SECRET = TEST_SECRET;
  (env as MockEnv).SECRET_BOX_KEY = undefined;
});

describe('deriveAuditCheckpointMacKey', () => {
  it('leitet per HKDF mit eigenem Info-Label ab, getrennt vom Secret-Box-Schlüssel', () => {
    const key = deriveAuditCheckpointMacKey();
    expect(key).toHaveLength(32);
    expect(key.equals(expected(TEST_SECRET, 'taxtronik-audit-verify-checkpoint-mac-v1'))).toBe(
      true,
    );
    expect(key.equals(expected(TEST_SECRET, 'taxtronik-secret-box-v2'))).toBe(false);
    expect(deriveAuditCheckpointMacKey().equals(key)).toBe(true);
  });

  it('nutzt SECRET_BOX_KEY, wenn gesetzt, statt AUTH_SECRET', () => {
    const fromAuthSecret = deriveAuditCheckpointMacKey();
    (env as MockEnv).SECRET_BOX_KEY = 'dedicated-secret-box-key-with-32-chars!!';
    const key = deriveAuditCheckpointMacKey();
    expect(key.equals(fromAuthSecret)).toBe(false);
    expect(
      key.equals(
        expected(
          'dedicated-secret-box-key-with-32-chars!!',
          'taxtronik-audit-verify-checkpoint-mac-v1',
        ),
      ),
    ).toBe(true);
  });
});
