import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';

import {
  ensureGwgPersonFolderTx,
  ensureGwgRootFolderTx,
  organizeGwgDocumentsTx,
} from '../document-folders';

function folderTx(foundId: string) {
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const findFirst = vi.fn().mockResolvedValue({ id: foundId });
  return {
    tx: { documentFolder: { createMany, findFirst } } as unknown as TxClient,
    createMany,
    findFirst,
  };
}

describe('GwG document folders', () => {
  it('legt den Mandanten-Wurzelordner idempotent und case-insensitiv an', async () => {
    const { tx, createMany, findFirst } = folderTx('root-1');
    await expect(
      ensureGwgRootFolderTx(tx, {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        createdByStaff: 'staff-1',
      }),
    ).resolves.toBe('root-1');
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ clientId: 'client-1', parentId: null, name: 'GwG' })],
      skipDuplicates: true,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ name: { equals: 'GwG', mode: 'insensitive' } }),
      }),
    );
  });

  it('bereinigt Personennamen und verwendet den Namen direkt als Unterordner', async () => {
    const { tx, createMany } = folderTx('person-1');
    await ensureGwgPersonFolderTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      rootFolderId: 'root-1',
      personName: '  Erika / Muster\\frau\n ',
      createdByStaff: 'staff-1',
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          parentId: 'root-1',
          name: 'Erika Muster frau',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('sortiert mehrere Ausweisseiten gesammelt in GwG/[Name der Person] ein', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: 'root-1' })
      .mockResolvedValueOnce({ id: 'person-1' });
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = {
      documentFolder: { createMany, findFirst },
      document: { updateMany },
    } as unknown as TxClient;

    await organizeGwgDocumentsTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      createdByStaff: 'staff-1',
      documents: [
        { documentId: 'front-1', personName: 'Erika Muster' },
        { documentId: 'back-1', personName: 'Erika Muster' },
      ],
    });

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['front-1', 'back-1'] },
        tenantId: 'tenant-1',
        clientId: 'client-1',
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
      },
      data: { folderId: 'person-1' },
    });
  });
});
