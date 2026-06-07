// =============================================================================
// Gemeinsamer Mapper Document-Row → ManagedDoc (für den DocumentsManager).
//
// Eine Quelle für die Tier-Ableitung + Feld-Abbildung — genutzt von der
// Mandanten-Detailseite UND dem Subsumtions-Tab „Aktenregal" (kein Doppel-Code).
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { ManagedDoc } from '@/components/documents-manager';

/** Felder, die der DocumentsManager (via toManagedDoc) braucht. */
export const MANAGED_DOC_SELECT = {
  id: true,
  title: true,
  classification: true,
  documentTypeId: true,
  documentType: { select: { name: true, tier: true } },
  createdAt: true,
  folderId: true,
  deletedAt: true,
  sharedWithClientAt: true,
  versions: { orderBy: { versionNo: 'desc' as const }, take: 1, select: { sizeBytes: true } },
} as const;

export interface ManagedDocRow {
  id: string;
  title: string;
  classification: string;
  documentTypeId: string | null;
  documentType: { name: string; tier: 'NONE' | 'GWG' | 'GOBD' } | null;
  createdAt: Date;
  folderId: string | null;
  deletedAt: Date | null;
  sharedWithClientAt: Date | null;
  versions: { sizeBytes: bigint }[];
}

export function toManagedDoc(d: ManagedDocRow): ManagedDoc {
  const tier: 'NONE' | 'GWG' | 'GOBD' =
    d.documentType?.tier ??
    (['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'].includes(d.classification)
      ? 'GOBD'
      : d.classification === 'GWG_EVIDENCE'
        ? 'GWG'
        : 'NONE');
  return {
    id: d.id,
    title: d.title,
    classification: d.classification,
    typeName: d.documentType?.name ?? '',
    typeId: d.documentTypeId,
    tier,
    sizeBytes: d.versions[0] ? Number(d.versions[0].sizeBytes) : 0,
    createdAt: d.createdAt.toISOString(),
    folderId: d.folderId,
    deletedAt: d.deletedAt ? d.deletedAt.toISOString() : null,
    shared: d.sharedWithClientAt != null,
  };
}

/** Dokumente, die diesem Sachverhalt zugeordnet sind (Aktenregal-Tab). */
export async function loadAnalysisDocuments(
  ctx: TenantContext,
  analysisId: string,
): Promise<ManagedDoc[]> {
  const rows = await withTenantContext(ctx, (tx) =>
    tx.document.findMany({
      where: { analysisId },
      orderBy: { createdAt: 'desc' },
      select: MANAGED_DOC_SELECT,
    }),
  );
  return rows.map(toManagedDoc);
}
