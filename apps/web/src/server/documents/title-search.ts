// =============================================================================
// Dokumentenseite (/staff/documents): Dokumente einer Ebene (ein Mandant oder
// Kanzlei-intern, ein Ordner, aktiv oder gelöscht), optional nach Titel
// gesucht.
//
// Review-Finding P-10, Welle 15: Prisma übersetzt `contains` + `insensitive`
// in ILIKE. Unter RLS darf PostgreSQL den Operator nicht als Indexbedingung
// nutzen (nicht LEAKPROOF); die Suche las jede Zeile der Ebene samt
// Policy-Prüfung, document_title_trgm_idx blieb ungenutzt. Die Suche läuft
// deshalb zweistufig: `app.document_title_search_candidates` (SECURITY
// DEFINER, Tenant und Akteur nur aus dem Kontext) liefert über den
// Trigram-Index die jüngsten sichtbaren Treffer der Ebene (höchstens `cap`)
// und meldet weitere; geladen werden nur diese IDs unter RLS mit dem
// unveränderten Filter. Treffer, Reihenfolge und Gesamtzahl bleiben gleich.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { MANAGED_DOC_SELECT, type ManagedDocRow } from './managed-docs';

export interface DocumentScope {
  tenantId: string;
  /** `null` = Kanzlei-intern. */
  clientId: string | null;
  /** `null` = Wurzel der Ebene (Dokumente ohne Ordner). */
  folderId: string | null;
  deleted: boolean;
  /** Getrimmter Suchbegriff; leer = keine Suche. */
  q: string;
  /** Höchstzahl geladener Dokumente (P-3); darüber zählt die Seite für den Hinweis. */
  cap: number;
}

export interface DocumentTitleCandidates {
  /** IDs der jüngsten sichtbaren Treffer in Listenreihenfolge, höchstens `cap`. */
  ids: string[];
  /** Es gibt mehr Treffer als `cap`. */
  truncated: boolean;
}

/** Stufe 1: Kandidaten über den Trigram-Index (nur IDs des eigenen Tenants). */
export async function documentTitleSearchCandidatesTx(
  tx: TxClient,
  scope: Omit<DocumentScope, 'tenantId'>,
): Promise<DocumentTitleCandidates> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT document_id::text AS id, ueberlauf
      FROM app.document_title_search_candidates(
        ${scope.clientId}::uuid,
        ${scope.folderId}::uuid,
        ${scope.deleted},
        ${scope.q},
        ${scope.cap}::int
      )
  `;
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    truncated: rows.some((row) => row.ueberlauf),
  };
}

/**
 * Dokumente der Ebene, neueste zuerst, höchstens `cap`; `docsTotal` ist die
 * Gesamtzahl für den Kürzungshinweis. Der Mandantenzugriff ist vorher zu
 * prüfen (canAccessClientTx); die Kandidatensuche prüft ihn zusätzlich selbst.
 */
export async function loadScopeDocumentsTx(
  tx: TxClient,
  scope: DocumentScope,
): Promise<{ docs: ManagedDocRow[]; docsTotal: number }> {
  const docWhere: Prisma.DocumentWhereInput = {
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    folderId: scope.folderId,
    deletedAt: scope.deleted ? { not: null } : null,
    ...(scope.q ? { title: { contains: scope.q, mode: 'insensitive' } } : {}),
  };
  if (!scope.q) {
    const docs = await tx.document.findMany({
      where: docWhere,
      orderBy: { createdAt: 'desc' },
      take: scope.cap,
      // Dasselbe DTO wie Mandanten-Tab und Aktenregal (server/documents).
      select: MANAGED_DOC_SELECT,
    });
    // Nur wenn der Cap erreicht wurde: Gesamtzahl für den Truncation-Hinweis.
    const docsTotal =
      docs.length === scope.cap ? await tx.document.count({ where: docWhere }) : docs.length;
    return { docs, docsTotal };
  }

  const candidates = await documentTitleSearchCandidatesTx(tx, scope);
  const docs =
    candidates.ids.length === 0
      ? []
      : await tx.document.findMany({
          // Unveränderter Filter samt Suchbegriff; RLS prüft jede geladene Zeile.
          where: { ...docWhere, id: { in: candidates.ids } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: scope.cap,
          select: MANAGED_DOC_SELECT,
        });
  // Wie bisher nur bei Kürzung genau zählen: einmal unter RLS über die Ebene.
  const docsTotal = candidates.truncated
    ? await tx.document.count({ where: docWhere })
    : docs.length;
  return { docs, docsTotal };
}
