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
    tenantId: input.tenantId,
    clientId: input.clientId,
    createdByStaff: input.createdByStaff,
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
    createdByStaff: string | null;
  },
): Promise<string> {
  const personName = normalizeFolderName(input.personName, 'Unbenannte Person');
  return ensureFolderTx(tx, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    parentId: input.rootFolderId,
    name: personName,
    createdByStaff: input.createdByStaff,
  });
}

export async function organizeGwgDocumentsTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    createdByStaff: string | null;
    documents: readonly {
      documentId: string;
      personName?: string | null;
    }[];
  },
): Promise<void> {
  if (input.documents.length === 0) return;

  const rootFolderId = await ensureGwgRootFolderTx(tx, input);
  const personFolderByName = new Map<string, string>();
  const folderByDocumentId = new Map<string, string>();

  for (const document of input.documents) {
    const personName = document.personName?.trim();
    let folderId = rootFolderId;
    if (personName) {
      const normalizedName = normalizeFolderName(personName, 'Unbenannte Person');
      const personKey = normalizedName.toLocaleLowerCase('de-DE');
      folderId = personFolderByName.get(personKey) ?? '';
      if (!folderId) {
        folderId = await ensureGwgPersonFolderTx(tx, {
          tenantId: input.tenantId,
          clientId: input.clientId,
          rootFolderId,
          personName: normalizedName,
          createdByStaff: input.createdByStaff,
        });
        personFolderByName.set(personKey, folderId);
      }
    }

    const assignedFolderId = folderByDocumentId.get(document.documentId);
    if (assignedFolderId && assignedFolderId !== folderId) {
      throw new Error('GWG_DOCUMENT_FOLDER_CONFLICT');
    }
    folderByDocumentId.set(document.documentId, folderId);
  }

  const documentIdsByFolder = new Map<string, string[]>();
  for (const [documentId, folderId] of folderByDocumentId) {
    const documentIds = documentIdsByFolder.get(folderId) ?? [];
    documentIds.push(documentId);
    documentIdsByFolder.set(folderId, documentIds);
  }

  for (const [folderId, documentIds] of documentIdsByFolder) {
    const updated = await tx.document.updateMany({
      where: {
        id: { in: documentIds },
        tenantId: input.tenantId,
        clientId: input.clientId,
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
      },
      data: { folderId },
    });
    if (updated.count !== documentIds.length) {
      throw new Error('GWG_DOCUMENT_FOLDER_ASSIGN_FAILED');
    }
  }
}
