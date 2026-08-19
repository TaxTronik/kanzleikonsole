import type { TxClient } from '@taxtronik/db';

export const GWG_ROOT_FOLDER_NAME = 'GwG';

function normalizeFolderName(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\p{Cc}/\\]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, 180).trim();
}

async function ensureFolderTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    parentId: string | null;
    name: string;
    createdByStaff: string | null;
  },
): Promise<string> {
  await tx.documentFolder.createMany({
    data: [input],
    skipDuplicates: true,
  });
  const folder = await tx.documentFolder.findFirst({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      parentId: input.parentId,
      name: { equals: input.name, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (!folder) throw new Error('GWG_DOCUMENT_FOLDER_CREATE_FAILED');
  return folder.id;
}

export function ensureGwgRootFolderTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    createdByStaff: string | null;
  },
): Promise<string> {
  return ensureFolderTx(tx, {
    ...input,
    parentId: null,
    name: GWG_ROOT_FOLDER_NAME,
  });
}

export function ensureGwgPersonFolderTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    rootFolderId: string;
    personName: string;
    role: 'OWNER' | 'REPRESENTATIVE';
    createdByStaff: string | null;
  },
): Promise<string> {
  const personName = normalizeFolderName(input.personName, 'Unbenannte Person');
  const roleLabel = input.role === 'OWNER' ? 'wirtschaftlich berechtigt' : 'Vertretung';
  return ensureFolderTx(tx, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    parentId: input.rootFolderId,
    name: normalizeFolderName(`${personName} – ${roleLabel}`, roleLabel),
    createdByStaff: input.createdByStaff,
  });
}
