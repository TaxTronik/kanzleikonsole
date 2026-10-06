// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Review-Finding K-06: Bausteine des Vorab-Journals (journal, store, settle, release).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('./storage-journal-fake');
  return { commitPreparedBytes: storageJournal.commit };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('./storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: Uint8Array) => value }));
vi.mock('@/server/logger', () => ({ log: h.log }));

import {
  journalStorageIntents,
  releaseStorageIntent,
  settleStorageIntentTx,
  storeStorageIntent,
} from '../storage-intent';
import { storageJournal } from './storage-journal-fake';
import type { TxClient } from '@taxtronik/db';

const tx = { $executeRaw: storageJournal.executeRaw } as unknown as TxClient;

async function prepared(content: string, tier: 'NONE' | 'GOBD' = 'NONE') {
  return storageJournal.prepare({ fileData: Buffer.from(content), tier, tenantId: 'tenant-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
});

describe('storage intent journal', () => {
  it('journalisiert mehrere Absichten in einer Owner-Transaktion mit eigener Herkunft', async () => {
    const transaction = vi.spyOn(storageJournal.owner, '$transaction');
    const intents = await journalStorageIntents({
      tenantId: 'tenant-1',
      intents: [
        { source: 'invoice.archive.zugferd_pdf', prepared: await prepared('pdf', 'GOBD') },
        { source: 'invoice.archive.xrechnung_xml', prepared: await prepared('xml', 'GOBD') },
      ],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(intents.map((intent) => intent.source)).toEqual([
      'invoice.archive.zugferd_pdf',
      'invoice.archive.xrechnung_xml',
    ]);
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({ intent: true, immutable: true, storageVersionId: '' }),
      expect.objectContaining({ intent: true, immutable: true, storageVersionId: '' }),
    ]);
  });

  it('lehnt eine Absicht ausserhalb des eigenen Tenant-Praefixes ab, bevor etwas journalisiert wird', async () => {
    const foreign = await prepared('foreign');
    await expect(
      journalStorageIntents({
        tenantId: 'tenant-2',
        intents: [{ source: 'test', prepared: foreign }],
      }),
    ).rejects.toThrow(/STORAGE_INTENT_TENANT_MISMATCH/);
    expect(storageJournal.rows).toEqual([]);
  });

  it('vermerkt einen gescheiterten PUT an der offenen Absicht', async () => {
    const [intent] = await journalStorageIntents({
      tenantId: 'tenant-1',
      intents: [{ source: 'test', prepared: await prepared('bytes') }],
    });
    storageJournal.failPut = new Error('socket hang up');

    await expect(storeStorageIntent(intent!, Buffer.from('bytes'))).rejects.toThrow(
      'socket hang up',
    );
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ failure: 'socket hang up', storageVersionId: '' }),
    ]);
  });

  it('schliesst nur die Absicht mit identischem Objekt ab', async () => {
    const [intent, other] = await journalStorageIntents({
      tenantId: 'tenant-1',
      intents: [
        { source: 'test', prepared: await prepared('a') },
        { source: 'test', prepared: await prepared('b') },
      ],
    });
    const otherCommit = await storeStorageIntent(other!, Buffer.from('b'));

    await expect(settleStorageIntentTx(tx, intent!, otherCommit)).rejects.toThrow(
      /STORAGE_INTENT_MISMATCH/,
    );
    expect(storageJournal.events).not.toContain('settle');
  });

  it('bindet bei Freigabe die Version an die offene Absicht (JOURNALED)', async () => {
    const [intent] = await journalStorageIntents({
      tenantId: 'tenant-1',
      intents: [{ source: 'test', prepared: await prepared('bytes') }],
    });
    const commit = await storeStorageIntent(intent!, Buffer.from('bytes'));

    await expect(
      releaseStorageIntent({ intent: intent!, commit, cause: new Error('db down') }),
    ).resolves.toBe('JOURNALED');
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ storageVersionId: commit.storageVersionId, failure: 'db down' }),
    ]);
  });

  it('kompensiert als Rueckfallebene, wenn die Absicht nicht mehr offen ist (COMPENSATED)', async () => {
    const [intent] = await journalStorageIntents({
      tenantId: 'tenant-1',
      intents: [{ source: 'test', prepared: await prepared('bytes') }],
    });
    const commit = await storeStorageIntent(intent!, Buffer.from('bytes'));
    storageJournal.rows[0]!.cleanedAt = new Date();
    storageJournal.rows[0]!.resolution = 'ABSENT';

    await expect(
      releaseStorageIntent({ intent: intent!, commit, cause: new Error('late put') }),
    ).resolves.toBe('COMPENSATED');
    expect(storageJournal.rows).toContainEqual(
      expect.objectContaining({
        intent: false,
        storageVersionId: commit.storageVersionId,
        failure: 'late put',
        cleanedAt: null,
      }),
    );
  });

  it('protokolliert vollstaendig, wenn auch die Freigabe scheitert (LOG_ONLY)', async () => {
    const [intent] = await journalStorageIntents({
      tenantId: 'tenant-1',
      intents: [{ source: 'test', prepared: await prepared('bytes') }],
    });
    const commit = await storeStorageIntent(intent!, Buffer.from('bytes'));
    vi.spyOn(storageJournal.owner.storageOrphan, 'updateMany').mockRejectedValueOnce(
      new Error('owner pool exhausted'),
    );

    await expect(
      releaseStorageIntent({ intent: intent!, commit, cause: new Error('db down') }),
    ).resolves.toBe('LOG_ONLY');
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: intent!.id,
        storageKey: commit.targetKey,
        sha256: commit.sha256.toString('hex'),
        journalError: 'owner pool exhausted',
      }),
      expect.any(String),
    );
  });
});
