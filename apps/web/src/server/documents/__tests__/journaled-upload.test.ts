// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Fachkatalog: DOC-OBJECT-LOCK-001
// Review-Finding K-06: Journal-first-Orchestrator fuer direkte Uploads.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('./storage-journal-fake');
  return {
    prepareBytesCommitWithTier: storageJournal.prepare,
    commitPreparedBytes: storageJournal.commit,
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('./storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: Uint8Array) => value }));
vi.mock('@/server/logger', () => ({ log: h.log }));

import {
  JournaledUploadError,
  runJournaledUpload,
  type JournaledUploadOptions,
} from '../journaled-upload';
import { processCrash, storageJournal, waitForEvent } from './storage-journal-fake';

const CONTEXT = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };
const tx = { $executeRaw: storageJournal.executeRaw };

type Checked = { tier: 'NONE' | 'GOBD' };
type Options = JournaledUploadOptions<Checked, { documentId: string }>;

function upload(overrides: Partial<Options> = {}) {
  const options: Options = {
    context: CONTEXT,
    source: 'test.upload',
    check: vi.fn(async (_tx: unknown, phase: 'pre' | 'post') => {
      storageJournal.events.push(`check:${phase}`);
      return { tier: 'GOBD' as const };
    }),
    readBytes: vi.fn(async () => {
      storageJournal.events.push('read');
      return Buffer.from('%PDF-1.7 beleg');
    }),
    storage: (checked: Checked) => ({ tier: checked.tier, classification: 'GOBD_INVOICE' }),
    commitTx: vi.fn(async () => {
      storageJournal.events.push('commit');
      return { documentId: 'doc-1' };
    }),
    ...overrides,
  };
  return runJournaledUpload(options);
}

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  h.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (value: unknown) => unknown) =>
    fn(tx),
  );
});

describe('runJournaledUpload', () => {
  it('journalisiert die Absicht vor dem PUT und schliesst sie in der Commit-Transaktion ab', async () => {
    const result = await upload();

    expect(result).toMatchObject({ result: { documentId: 'doc-1' }, referenced: true });
    expect(storageJournal.events).toEqual([
      'check:pre',
      'read',
      'prepare',
      'journal',
      `put:${storageJournal.objects[0]!.key}`,
      'check:post',
      'commit',
      'settle',
    ]);
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'test.upload',
        intent: true,
        storageBucket: 'bucket-gobd',
        storageKey: storageJournal.objects[0]!.key,
        storageVersionId: storageJournal.objects[0]!.versionId,
        immutable: true,
        resolution: 'REFERENCED',
        cleanedAt: expect.any(Date),
      }),
    ]);
  });

  it('Prozessabbruch zwischen PUT und DB-Commit hinterlaesst eine offene, aufloesbare Absicht', async () => {
    h.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (value: unknown) => unknown) => fn(tx))
      .mockImplementationOnce(() => processCrash());

    void upload();
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(storageJournal.rows).toHaveLength(1);
    expect(intent).toMatchObject({ storageVersionId: '', resolution: null, failure: null });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
    expect(storageJournal.events).not.toContain('settle');
  });

  it('bricht vor Scan, Journal und Object-Write ab, wenn die Vorpruefung scheitert', async () => {
    const error = await upload({
      check: vi.fn().mockRejectedValue(new Error('CLIENT_NOT_FOUND')),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JournaledUploadError);
    expect(error).toMatchObject({ phase: 'check', message: 'CLIENT_NOT_FOUND' });
    expect(storageJournal.events).toEqual([]);
  });

  it('schreibt weder Journal noch Objekt bei infizierten Bytes', async () => {
    const error = await upload({
      readBytes: vi.fn(async () => Buffer.from('EICAR-test')),
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ phase: 'prepare' });
    expect((error as JournaledUploadError).message).toMatch(/^INFECTED/);
    expect(storageJournal.rows).toEqual([]);
    expect(storageJournal.objects).toEqual([]);
  });

  it('schreibt kein Objekt, wenn das Journal scheitert', async () => {
    storageJournal.failJournal = new Error('owner down');

    await expect(upload()).rejects.toMatchObject({ phase: 'journal' });
    expect(storageJournal.events.some((event) => event.startsWith('put:'))).toBe(false);
  });

  it('laesst die Absicht nach gescheitertem PUT offen und vermerkt den Fehler', async () => {
    storageJournal.failPut = new Error('S3 timeout');

    await expect(upload()).rejects.toMatchObject({ phase: 'store', message: 'S3 timeout' });
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ failure: 'S3 timeout', storageVersionId: '' }),
    ]);
    expect(storageJournal.events).not.toContain('check:post');
  });

  it('bindet nach gescheitertem Commit die Objektversion an die offene Absicht', async () => {
    const error = await upload({
      commitTx: vi.fn().mockRejectedValue(new Error('REFERENCE_CHANGED')),
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ phase: 'commit', message: 'REFERENCE_CHANGED' });
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        storageVersionId: storageJournal.objects[0]!.versionId,
        failure: 'REFERENCE_CHANGED',
      }),
    ]);
    expect(storageJournal.events).not.toContain('compensate');
  });

  it('kompensiert nur als Rueckfallebene, wenn die Absicht nicht mehr offen ist', async () => {
    const error = await upload({
      commitTx: vi.fn(async () => {
        // Der Worker hat die (extrem verspaetete) Absicht inzwischen beansprucht.
        storageJournal.rows[0]!.cleanupClaimedAt = new Date();
        storageJournal.rows[0]!.cleanedAt = new Date();
        return { documentId: 'doc-1' };
      }),
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ phase: 'commit' });
    expect((error as JournaledUploadError).message).toMatch(/STORAGE_INTENT_NOT_OPEN/);
    expect(storageJournal.events).toContain('compensate');
    expect(storageJournal.rows).toContainEqual(
      expect.objectContaining({
        intent: false,
        storageKey: storageJournal.objects[0]!.key,
        storageVersionId: storageJournal.objects[0]!.versionId,
        cleanedAt: null,
      }),
    );
  });

  it('laesst ein nicht uebernommenes Objekt fuer den Worker offen', async () => {
    const result = await upload({ referenced: () => false });

    expect(result.referenced).toBe(false);
    expect(storageJournal.events).not.toContain('settle');
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        storageVersionId: storageJournal.objects[0]!.versionId,
        failure: expect.stringContaining('nicht übernommen'),
      }),
    ]);
  });

  it('lehnt eine Absicht mit fremdem Tenant-Praefix vor dem Journal ab', async () => {
    const error = await upload({
      context: { ...CONTEXT, tenantId: 'tenant-2' },
      storage: () => ({ tier: 'NONE' }),
      afterPrepare: ({ prepared }) => {
        prepared.targetKey = 'tenants/tenant-1/none/foreign.bin';
      },
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ phase: 'journal' });
    expect((error as JournaledUploadError).message).toMatch(/STORAGE_INTENT_TENANT_MISMATCH/);
    expect(storageJournal.objects).toEqual([]);
  });
});
