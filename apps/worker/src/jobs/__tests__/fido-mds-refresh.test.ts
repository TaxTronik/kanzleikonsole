// Fachkatalog: ACCESS-TENANT-RLS-001
// P-23: Worker-Job fido-mds-refresh. Download/Prüfung (fido-mds-verify) und
// Ablage (@taxtronik/db/fido-mds-snapshot, DB-Test fido-mds-snapshot.test.ts)
// sind hier ersetzt; geprüft wird die Verdrahtung.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  allowlist: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] as string[],
  download: vi.fn(),
  store: vi.fn(),
  prismaOwner: { marker: 'owner' },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('@taxtronik/config', () => ({
  env: {
    get WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST() {
      return h.allowlist;
    },
  },
}));
vi.mock('../fido-mds-verify', () => ({ downloadVerifiedFidoMetadata: h.download }));
vi.mock('@taxtronik/db/fido-mds-snapshot', () => ({ storeFidoMdsSnapshot: h.store }));

import { processors } from './mocks/bullmq';
import { runFidoMdsRefresh } from '../fido-mds-refresh';

const BLOB = 'header.payload.signature';
const ENTRIES = [{ aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];

beforeEach(() => {
  vi.resetAllMocks();
  h.allowlist = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
  h.download.mockResolvedValue({
    blob: BLOB,
    serial: 7,
    nextUpdate: new Date('2099-01-01T00:00:00.000Z'),
    entries: ENTRIES,
  });
  h.store.mockResolvedValue('stored');
});

describe('fido-mds-refresh', () => {
  it.each([
    ['ohne Allowlist', []],
    ['mit Null-AAGUID', ['00000000-0000-0000-0000-000000000000']],
  ])(
    'ruft bei zentral deaktiviertem Hardware-Zugang (%s) keinen MDS-Stand ab',
    async (_case, list) => {
      h.allowlist = list;
      await expect(runFidoMdsRefresh()).resolves.toEqual({ status: 'disabled' });
      expect(h.download).not.toHaveBeenCalled();
      expect(h.store).not.toHaveBeenCalled();
    },
  );

  it('speichert den geprüften Stand mit BLOB-Prüfsumme über den Owner-Client', async () => {
    await expect(runFidoMdsRefresh()).resolves.toEqual({
      status: 'stored',
      serial: 7,
      nextUpdate: '2099-01-01',
      entries: 1,
    });
    expect(h.store).toHaveBeenCalledWith(h.prismaOwner, {
      serial: 7,
      nextUpdate: new Date('2099-01-01T00:00:00.000Z'),
      blobSha256: createHash('sha256').update(BLOB, 'utf8').digest('hex'),
      entries: ENTRIES,
    });
    expect(h.log.info).toHaveBeenCalledWith(
      { status: 'stored', serial: 7, nextUpdate: '2099-01-01', entries: 1 },
      'fido-mds-refresh: neuer geprüfter MDS-Stand gespeichert',
    );
  });

  it('meldet einen unveränderten Stand nur auf Debug-Ebene', async () => {
    h.store.mockResolvedValueOnce('unchanged');
    await expect(runFidoMdsRefresh()).resolves.toMatchObject({ status: 'unchanged' });
    expect(h.log.info).not.toHaveBeenCalled();
    expect(h.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unchanged', serial: 7 }),
      'fido-mds-refresh: MDS-Stand unverändert, Prüfzeitpunkt erneuert',
    );
  });

  it('lässt einen fehlgeschlagenen Abruf oder eine fehlgeschlagene Prüfung den Job scheitern', async () => {
    h.download.mockRejectedValueOnce(
      new Error('Zeitlimit der FIDO-Metadatenprüfung überschritten'),
    );
    await expect(processors.get('fido-mds-refresh')!({ data: {} })).rejects.toThrow(
      'Zeitlimit der FIDO-Metadatenprüfung überschritten',
    );
    expect(h.store).not.toHaveBeenCalled();
  });

  it('lässt einen älteren BLOB als den verankerten Stand den Job scheitern', async () => {
    h.store.mockRejectedValueOnce(
      new Error('Der signierte FIDO-MDS-BLOB ist älter als der persistente Vertrauensstand'),
    );
    await expect(processors.get('fido-mds-refresh')!({ data: {} })).rejects.toThrow(
      /älter als der persistente Vertrauensstand/,
    );
  });

  it('registriert den Processor auf der Queue fido-mds-refresh', async () => {
    await expect(processors.get('fido-mds-refresh')!({ data: {} })).resolves.toBeUndefined();
    expect(h.download).toHaveBeenCalledOnce();
    expect(h.store).toHaveBeenCalledOnce();
  });
});
