// =============================================================================
// EIN Dokument-DTO für den DocumentExplorer (Browser- und Embedded-Variante):
// Select, Tier-Ableitung und Mapper an einer Stelle — genutzt von
// /staff/documents, der Mandanten-Detailseite und dem Subsumtions-Tab
// „Aktenregal".
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';

export type DocumentTier = 'NONE' | 'GWG' | 'GOBD';

/** Dokument-Zeile des DocumentExplorer (beide Varianten). */
export interface ManagedDoc {
  id: string;
  title: string;
  mimeType: string;
  classification: string;
  typeName: string;
  typeId: string | null;
  tier: DocumentTier;
  sizeBytes: number;
  createdAt: string;
  folderId: string | null;
  deletedAt: string | null;
  shared: boolean;
}

/** Felder, die der DocumentExplorer (via toManagedDoc) braucht. */
export const MANAGED_DOC_SELECT = {
  id: true,
  title: true,
  mimeType: true,
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
  mimeType: string;
  classification: string;
  documentTypeId: string | null;
  documentType: { name: string; tier: DocumentTier } | null;
  createdAt: Date;
  folderId: string | null;
  deletedAt: Date | null;
  sharedWithClientAt: Date | null;
  versions: { sizeBytes: bigint }[];
}

const GOBD_CLASSIFICATIONS: readonly string[] = ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'];

/**
 * Schutzstufe: aus dem Dokumenttyp, für Altbestände ohne Typ aus der Klassifikation
 * (dieselbe Regel wie classificationToTier in @taxtronik/storage; hier ohne Import,
 * weil das Paket beim Laden die Umgebungskonfiguration parst).
 */
export function documentTier(
  classification: string,
  typeTier: DocumentTier | null | undefined,
): DocumentTier {
  if (typeTier) return typeTier;
  if (GOBD_CLASSIFICATIONS.includes(classification)) return 'GOBD';
  return classification === 'GWG_EVIDENCE' ? 'GWG' : 'NONE';
}

export function toManagedDoc(d: ManagedDocRow): ManagedDoc {
  return {
    id: d.id,
    title: d.title,
    mimeType: d.mimeType,
    classification: d.classification,
    typeName: d.documentType?.name ?? '',
    typeId: d.documentTypeId,
    tier: documentTier(d.classification, d.documentType?.tier),
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
