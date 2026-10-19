// TCMS Stufe 2: Client einmal je Prozess, Gate „Modul an UND Deployment aktiv".
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modules = vi.hoisted(() => ({ readModules: vi.fn(), readModulesTx: vi.fn() }));
vi.mock('@/server/settings/modules', () => modules);

import {
  TcmsInaktivError,
  assertTcmsAktiv,
  assertTcmsAktivTx,
  tcmsAktivTx,
  tcmsClient,
  tcmsDienstZuruecksetzen,
} from '../dienst';

const ORIGINAL = process.env;
const tx = {} as never;
const ctx = { tenantId: 't', actorId: 's', actorType: 'STAFF' } as const;

function konfiguriert() {
  process.env = {
    ...ORIGINAL,
    NODE_ENV: 'test',
    TCMS_DEPLOYMENT: 'managed',
    TCMS_URL: 'http://tcms-api:3200',
    TCMS_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
    TCMS_ACTOR_PRIVATE_KEY: generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    TCMS_ACTOR_KEY_ID: 'kk-1',
  };
}

beforeEach(() => {
  tcmsDienstZuruecksetzen();
  process.env = { ...ORIGINAL, TCMS_DEPLOYMENT: '' };
});
afterEach(() => {
  process.env = ORIGINAL;
  tcmsDienstZuruecksetzen();
  vi.resetAllMocks();
});

describe('tcmsClient', () => {
  it('liefert null bei TCMS_DEPLOYMENT=disabled', () => {
    expect(tcmsClient()).toBeNull();
  });

  it('baut den Client einmal je Prozess (Schlüssel einmal geladen)', () => {
    konfiguriert();
    const client = tcmsClient();
    expect(client).not.toBeNull();
    expect(tcmsClient()).toBe(client);
    expect(JSON.stringify(client)).toBe('{"origin":"http://tcms-api:3200","kid":"kk-1"}');
  });
});

describe('Gate: Modul tcms an UND TCMS_DEPLOYMENT aktiv', () => {
  it('ist nur aktiv, wenn beides zutrifft', async () => {
    for (const [modulAn, konfig, erwartet] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ] as const) {
      tcmsDienstZuruecksetzen();
      if (konfig) konfiguriert();
      else process.env = { ...ORIGINAL, TCMS_DEPLOYMENT: 'disabled' };
      modules.readModulesTx.mockResolvedValue({ tcms: modulAn });
      modules.readModules.mockResolvedValue({ tcms: modulAn });
      expect(await tcmsAktivTx(tx, 't'), `${modulAn}/${konfig}`).toBe(erwartet);
      const tx1 = assertTcmsAktivTx(tx, 't');
      const ctx1 = assertTcmsAktiv(ctx);
      if (erwartet) {
        await expect(tx1).resolves.toBeUndefined();
        await expect(ctx1).resolves.toBeUndefined();
      } else {
        await expect(tx1).rejects.toBeInstanceOf(TcmsInaktivError);
        await expect(ctx1).rejects.toThrow('Das Tax-CMS ist für diese Kanzlei nicht aktiv.');
      }
    }
  });
});
