import { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

export interface CleanGwgEvidenceDocument {
  id: string;
  title: string;
  createdAt: Date;
}

function escapedLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Liefert nur tatsächlich verfügbare GwG-Belege, deren jeweils neueste
 * Dateiversion vollständig geprüft und CLEAN ist. Ein älteres CLEAN darf eine
 * neuere PENDING-/INFECTED-Version niemals überdecken.
 */
export async function findCleanGwgEvidenceDocumentsTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    query?: string;
    excludeLinkedCheckId?: string;
    limit: number;
  },
): Promise<CleanGwgEvidenceDocument[]> {
  const queryClause = input.query?.trim()
    ? Prisma.sql`AND d."title" ILIKE ${escapedLikePattern(input.query.trim())} ESCAPE '\'`
    : Prisma.empty;
  const excludeLinkedClause = input.excludeLinkedCheckId
    ? Prisma.sql`
        AND NOT EXISTS (
          SELECT 1
            FROM public."gwg_id_document" gid
           WHERE gid."gwg_check_id" = ${input.excludeLinkedCheckId}::uuid
             AND gid."document_id" = d."id"
        )
      `
    : Prisma.empty;

  return tx.$queryRaw<CleanGwgEvidenceDocument[]>(Prisma.sql`
    SELECT d."id", d."title", d."created_at" AS "createdAt"
      FROM public."document" d
      JOIN LATERAL (
        SELECT dv."scan_status", dv."scan_completed_at"
          FROM public."document_version" dv
         WHERE dv."document_id" = d."id"
         ORDER BY dv."version_no" DESC
         LIMIT 1
      ) latest ON latest."scan_status" = 'CLEAN'
              AND latest."scan_completed_at" IS NOT NULL
     WHERE d."tenant_id" = ${input.tenantId}::uuid
       AND d."client_id" = ${input.clientId}::uuid
       AND d."classification" = 'GWG_EVIDENCE'
       AND d."deleted_at" IS NULL
       AND d."gwg_destruction_requested_at" IS NULL
       AND d."gwg_destroyed_at" IS NULL
       ${queryClause}
       ${excludeLinkedClause}
     ORDER BY d."created_at" DESC, d."id" DESC
     LIMIT ${input.limit}
  `);
}

/**
 * Sperrt alle ausgewählten Document-Zeilen bis zum Transaktionsende und prüft
 * Scope, Verfügbarkeit sowie die neueste Scan-Version in demselben Snapshot.
 * Der Document-Lock serialisiert Soft-Delete, Vernichtung und New-Version-
 * Commit mit der anschließenden GwG-Verknüpfung/-Bestätigung.
 */
export async function lockCleanGwgEvidenceDocumentsTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string; documentIds: string[] },
): Promise<boolean> {
  const documentIds = [...new Set(input.documentIds)].sort();
  if (documentIds.length === 0) return false;

  // Zwei Statements sind Absicht: PostgreSQL kann bei einem einzigen
  // JOIN+LockRows-Statement den LATERAL-Snapshot vor dem Warten auf einen
  // parallelen Document-Writer lesen. Erst Parent-Zeilen sperren, danach unter
  // gehaltenem Lock die neueste Version mit einem frischen Statement-Snapshot
  // prüfen. New-Version-Commit/DB-Trigger verwenden denselben Parent-Lock.
  const lockedDocuments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT d."id"
      FROM public."document" d
     WHERE d."id" IN (${Prisma.join(documentIds.map((id) => Prisma.sql`${id}::uuid`))})
       AND d."tenant_id" = ${input.tenantId}::uuid
       AND d."client_id" = ${input.clientId}::uuid
       AND d."classification" = 'GWG_EVIDENCE'
       AND d."deleted_at" IS NULL
       AND d."gwg_destruction_requested_at" IS NULL
       AND d."gwg_destroyed_at" IS NULL
     ORDER BY d."id"
     FOR SHARE OF d
  `);
  if (lockedDocuments.length !== documentIds.length) return false;

  const cleanLatestVersions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT d."id"
      FROM public."document" d
      JOIN LATERAL (
        SELECT dv."scan_status", dv."scan_completed_at"
          FROM public."document_version" dv
         WHERE dv."document_id" = d."id"
         ORDER BY dv."version_no" DESC
         LIMIT 1
      ) latest ON latest."scan_status" = 'CLEAN'
              AND latest."scan_completed_at" IS NOT NULL
     WHERE d."id" IN (${Prisma.join(documentIds.map((id) => Prisma.sql`${id}::uuid`))})
     ORDER BY d."id"
  `);
  return cleanLatestVersions.length === documentIds.length;
}
