// =============================================================================
// S3-Client und Konfiguration beim ersten Zugriff (Review-Befund K-09).
//
// Der Import des Pakets liest keine ENV und wertet @taxtronik/config nicht aus;
// Tests brauchen keine Minimal-ENV mehr (vitest.config.ts setzt keine). Der
// erste Zugriff validiert Core, S3 und ClamAV (Profil „cli-storage“) mit
// denselben Defaults und Fehlern wie die Boot-Validierung, und der Client
// entsteht genau einmal mit der bisherigen Konfiguration.
// =============================================================================

import { createServer, type AddressInfo, type Server } from 'node:net';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { envProfileKeys, parseEnvProfileFrom } from '@taxtronik/config/env-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Die beim Import validierte ENV von @taxtronik/config darf das Paket nicht laden.
vi.mock('@taxtronik/config', () => {
  throw new Error('@taxtronik/storage darf @taxtronik/config nicht beim Import auswerten (K-09).');
});

const STORAGE_ENV = {
  S3_ENDPOINT: 'http://seaweedfs:8333',
  S3_REGION: 'eu-central-1',
  S3_ACCESS_KEY: 'storage-test-access',
  S3_SECRET_KEY: 'storage-test-secret',
};

/** Prozess-ENV ohne jeden Wert des Web-Profils (Obermenge aller Profile), plus `values`. */
function useEnv(values: Record<string, string> = {}): void {
  for (const key of envProfileKeys('web')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

/** Meldung, mit der die Boot-Validierung (Profil „cli-storage“) dieselbe ENV ablehnt. */
function bootValidationError(): string {
  try {
    parseEnvProfileFrom('cli-storage', process.env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Testaufbau: die ENV ist gültig.');
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('@taxtronik/storage ohne ENV beim Import (K-09)', () => {
  it('lädt das Paket ohne ENV und ohne @taxtronik/config', async () => {
    useEnv();
    const storage = await import('../index');
    expect(typeof storage.s3.send).toBe('function');
    expect(typeof storage.getS3Client).toBe('function');
    expect(storage.MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('scheitert erst beim ersten Zugriff, mit dem Fehler der Boot-Validierung', async () => {
    useEnv();
    const expected = bootValidationError();
    consoleError.mockClear();
    const { s3, getS3Client, getBucketForClassification, getBucketForTier } =
      await import('../client');
    const { scanBytes } = await import('../service');

    expect(() => getS3Client()).toThrow(expected);
    expect(() => getBucketForTier('GOBD')).toThrow(expected);
    expect(() => getBucketForClassification('GWG_EVIDENCE')).toThrow(expected);
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'gobd' }))).rejects.toThrow(expected);
    await expect(scanBytes(Buffer.from('x'))).rejects.toThrow(expected);
    // Dieselbe Befundliste auf der Konsole wie beim Start.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/ENV-Validierung fehlgeschlagen:[\s\S]*S3_ENDPOINT/),
    );
  });

  it('wendet die Produktionsprüfungen beim ersten Zugriff an', async () => {
    useEnv({ ...STORAGE_ENV, NODE_ENV: 'production' });
    const expected = bootValidationError();
    expect(expected).toBe(
      '[config] S3_SECRET_KEY ist in Produktion Pflicht mit mindestens 32 Zeichen.',
    );
    const { getBucketForTier } = await import('../client');
    expect(() => getBucketForTier('GWG')).toThrow(expected);
  });
});

describe('S3-Client beim ersten Zugriff', () => {
  it('entsteht einmal, mit der bisherigen Konfiguration, und dient s3.send', async () => {
    useEnv(STORAGE_ENV);
    const { s3, getS3Client } = await import('../client');
    const client = getS3Client();
    expect(getS3Client()).toBe(client);

    await expect(client.config.endpoint!()).resolves.toMatchObject({
      protocol: 'http:',
      hostname: 'seaweedfs',
      port: 8333,
      path: '/',
    });
    await expect(client.config.region()).resolves.toBe('eu-central-1');
    await expect(client.config.credentials()).resolves.toMatchObject({
      accessKeyId: STORAGE_ENV.S3_ACCESS_KEY,
      secretAccessKey: STORAGE_ENV.S3_SECRET_KEY,
    });
    expect(client.config.forcePathStyle).toBe(true);
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
    const handler = client.config.requestHandler;
    expect(handler).toBeInstanceOf(NodeHttpHandler);
    await expect(
      (handler as unknown as { configProvider: Promise<object> }).configProvider,
    ).resolves.toMatchObject({ connectionTimeout: 5_000, socketTimeout: 30_000 });

    const send = vi
      .spyOn(client as unknown as { send: (...args: unknown[]) => Promise<unknown> }, 'send')
      .mockResolvedValue({});
    const command = new HeadBucketCommand({ Bucket: 'gobd' });
    await expect(s3.send(command)).resolves.toEqual({});
    expect(send).toHaveBeenCalledWith(command);
  });

  it('liefert Buckets mit den bisherigen Defaults und hält die Werte ab dem ersten Zugriff fest', async () => {
    useEnv({ ...STORAGE_ENV, S3_BUCKET_GWG: 'gwg-evidence' });
    const { getBucketForClassification, getBucketForTier } = await import('../client');
    expect(getBucketForTier('GOBD')).toBe('gobd');
    expect(getBucketForTier('GWG')).toBe('gwg-evidence');
    expect(getBucketForTier('NONE')).toBe('general');
    expect(getBucketForClassification('GOBD_INVOICE')).toBe('gobd');
    expect(getBucketForClassification('STAFF_PRIVATE')).toBe('staff-private');
    expect(getBucketForClassification('CORRESPONDENCE')).toBe('general');
    // Wie die früher beim Import validierte ENV: spätere Änderungen wirken nicht.
    vi.stubEnv('S3_BUCKET_GWG', 'changed-later');
    expect(getBucketForTier('GWG')).toBe('gwg-evidence');
  });
});

describe('ClamAV-Scan beim ersten Zugriff', () => {
  let clamd: Server | undefined;

  afterEach(async () => {
    await new Promise((resolve) => (clamd ? clamd.close(resolve) : resolve(undefined)));
    clamd = undefined;
  });

  it('verbindet sich mit CLAMAV_HOST und CLAMAV_PORT aus der Konfiguration', async () => {
    const received: Buffer[] = [];
    clamd = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        // INSTREAM endet mit einem leeren Chunk (vier Nullbytes).
        if (Buffer.concat(received).subarray(-4).equals(Buffer.alloc(4))) {
          socket.end('stream: OK\0');
        }
      });
    });
    await new Promise<void>((resolve) => clamd!.listen(0, '127.0.0.1', resolve));
    const { port } = clamd.address() as AddressInfo;

    useEnv({ ...STORAGE_ENV, CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port) });
    const { scanBytes } = await import('../service');
    await expect(scanBytes(Buffer.from('synthetic upload'))).resolves.toBe('CLEAN');
    expect(Buffer.concat(received).subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
  });
});
