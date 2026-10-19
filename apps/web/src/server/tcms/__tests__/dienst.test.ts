// TCMS Stufe 2: Client einmal je Prozess, Gate „Modul an UND Deployment aktiv".
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { TcmsUngueltig } from '@taxtronik/tcms-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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

  it('signiert keinen Systemakteur: den bildet allein der Zustell-Worker (Stufe 4)', async () => {
    konfiguriert();
    const fehler = await tcmsClient()!
      .aufruf({
        methode: 'GET',
        pfad: '/v1/nachrichten/offen',
        antwortSchema: z.unknown(),
        akteur: {
          tnt: '7a1e0000-0000-4000-8000-00000000d3e0',
          sub: 'c1000000-0000-4000-8000-0000000000aa',
          knd: 'SYSTEM',
          nam: 'Zustellung kanzleikonsole',
        },
      })
      .catch((error: unknown) => error);
    expect(fehler).toBeInstanceOf(TcmsUngueltig);
    expect((fehler as TcmsUngueltig).felder).toEqual({
      'akteur.knd': ['Akteursart für diesen Client nicht zugelassen'],
    });
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
