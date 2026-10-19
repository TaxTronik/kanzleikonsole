// TCMS Stufe 2: Worker-Gate „Modul tcms an UND TCMS_DEPLOYMENT aktiv".
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ modules: {} as Record<string, unknown>, aufrufe: 0 }));
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (_tenantId: string, fn: (tx: unknown) => unknown) => {
    db.aufrufe += 1;
    return fn({
      tenantSetting: { findUnique: async () => ({ value: db.modules }) },
    });
  },
}));

import { isWorkerTcmsActive } from '../module-gate';

const ORIGINAL = process.env;
const TCMS = {
  TCMS_DEPLOYMENT: 'managed',
  TCMS_URL: 'http://tcms-api:3200',
  TCMS_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
  TCMS_ACTOR_PRIVATE_KEY: generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64'),
  TCMS_ACTOR_KEY_ID: 'kk-1',
};

afterEach(() => {
  process.env = ORIGINAL;
  db.aufrufe = 0;
});

describe('isWorkerTcmsActive', () => {
  it('verlangt Modulschalter und Deployment', async () => {
    for (const [modulAn, deployt, erwartet] of [
      [true, true, true],
      [false, true, false],
      [true, false, false],
    ] as const) {
      process.env = deployt
        ? { ...ORIGINAL, ...TCMS }
        : { ...ORIGINAL, TCMS_DEPLOYMENT: 'disabled' };
      db.modules = { tcms: modulAn };
      expect(await isWorkerTcmsActive('tenant'), `${modulAn}/${deployt}`).toBe(erwartet);
    }
  });

  it('liest ohne Deployment keine Tenant-Einstellung', async () => {
    process.env = { ...ORIGINAL, TCMS_DEPLOYMENT: '' };
    expect(await isWorkerTcmsActive('tenant')).toBe(false);
    expect(db.aufrufe).toBe(0);
  });

  it('ist ohne gespeicherten Schalter aus (Standard)', async () => {
    process.env = { ...ORIGINAL, ...TCMS };
    db.modules = {};
    expect(await isWorkerTcmsActive('tenant')).toBe(false);
  });
});
