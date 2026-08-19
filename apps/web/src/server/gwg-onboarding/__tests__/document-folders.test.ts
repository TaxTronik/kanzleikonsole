import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';

import { ensureGwgPersonFolderTx, ensureGwgRootFolderTx } from '../document-folders';

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

  it('bereinigt Personennamen und trennt wirtschaftlich Berechtigte von Vertretungen', async () => {
    const { tx, createMany } = folderTx('person-1');
    await ensureGwgPersonFolderTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
      rootFolderId: 'root-1',
      personName: '  Erika / Muster\\frau\n ',
      role: 'OWNER',
      createdByStaff: 'staff-1',
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          parentId: 'root-1',
          name: 'Erika Muster frau – wirtschaftlich berechtigt',
        }),
      ],
      skipDuplicates: true,
    });
  });
});
