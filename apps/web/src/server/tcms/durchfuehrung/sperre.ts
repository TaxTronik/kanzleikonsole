// =============================================================================
// Lösch- und Versionssperre für Dokumente, auf die ein Nachweis des Tax-CMS
// verweist (TCMS Stufe 3, Fachkatalog TCMS-NACHWEIS-001). Genutzt von der
// Löschaktion der Ablage (documents/actions.ts) und der Versions-Route
// (api/staff/documents/[id]/new-version/commit). Die Datenbank sperrt das
// Soft-Delete zusätzlich (Trigger document_tcms_reference_delete_guard).
//
// Bewusst ohne weitere Importe: Die Dokumentpfade und ihre Tests sollen keine
// TCMS-Abhängigkeiten laden.
// =============================================================================

import type { TxClient } from '@taxtronik/db';

/** Löschen gesperrt (Ablage, Bulk-Aktion). */
export const TCMS_NACHWEIS_LOESCHSPERRE =
  'Dieses Dokument ist als Nachweis einer Kontrolldurchführung im Tax-CMS verknüpft und kann nicht gelöscht werden. Entfernen Sie zuerst den Nachweis in der Durchführung.';

/** Neue Version gesperrt (Versions-Route). */
export const TCMS_NACHWEIS_VERSIONSSPERRE =
  'Dieses Dokument ist als Nachweis im Tax-CMS verknüpft; eine neue Version würde den Nachweis verändern. Laden Sie die neue Fassung als eigenes Dokument hoch und hängen Sie sie als weiteren Nachweis an.';

/**
 * Offene Verknüpfung auf das Dokument? Als eigenes Statement NACH der Sperre
 * der Dokumentzeile aufrufen (wie die GwG-Prüfung der Ablage): Unter READ
 * COMMITTED sieht erst ein neues Statement eine Verknüpfung, die während des
 * Wartens auf die Sperre committet wurde; eine spätere Verknüpfung wartet
 * ihrerseits auf die Dokumentsperre.
 */
export async function istNachweisDokumentTx(tx: TxClient, documentId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ verknuepft: boolean }>>`
    SELECT EXISTS (
      SELECT 1
        FROM tcms_document_reference r
       WHERE r.document_id = ${documentId}::uuid
         AND r.released_at IS NULL
    ) AS verknuepft
  `;
  return rows[0]?.verknuepft === true;
}
