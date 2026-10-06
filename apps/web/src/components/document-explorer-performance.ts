interface FolderRef {
  id: string;
  parentId: string | null;
}

interface DocumentFolderRef {
  folderId: string | null;
  /** Anzahl Dokumente dieser Zeile (z. B. aus groupBy); Standard 1. */
  count?: number;
}

export interface FolderDocumentCounts {
  byId: Map<string, number>;
  withoutFolder: number;
}

/** Aggregiert direkte Dokumente und die Summen aller Unterordner in einem Lauf. */
export function buildFolderDocumentCounts(
  folders: readonly FolderRef[],
  documents: readonly DocumentFolderRef[],
): FolderDocumentCounts {
  const byId = new Map<string, number>();
  const parentById = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  let withoutFolder = 0;

  for (const document of documents) {
    const count = document.count ?? 1;
    if (!document.folderId) {
      withoutFolder += count;
      continue;
    }
    let folderId: string | null = document.folderId;
    const visited = new Set<string>();
    while (folderId && !visited.has(folderId)) {
      visited.add(folderId);
      byId.set(folderId, (byId.get(folderId) ?? 0) + count);
      folderId = parentById.get(folderId) ?? null;
    }
  }

  return { byId, withoutFolder };
}
