// =============================================================================
// Lösch- und Versionssperre für Dokumente, auf die ein Nachweis oder – seit
// TCMS s7 – die Anlage einer Ereignismeldung des Tax-CMS verweist (TCMS Stufe
// 3, Fachkatalog TCMS-NACHWEIS-001). Genutzt von der
// Löschaktion der Ablage (documents/actions.ts) und der Versions-Route
// (api/staff/documents/[id]/new-version/commit). Die Datenbank sperrt das
// Soft-Delete zusätzlich (Trigger document_tcms_reference_delete_guard).
//
// RT3B-K-01: Auch die Umklassifizierung der Ablage (documents/retag.ts) und
// die GwG-Pflichtvernichtung (admin/gwg-retention/actions.ts) prüfen die
// Bindung; die Datenbank weist den Wechsel in einen ausgeschlossenen Rahmen
// (document_tcms_reference_scope_guard) und die Vernichtung
// (app.assert_gwg_document_destruction_due) ebenso ab.
//
// Bewusst ohne weitere Importe: Die Dokumentpfade und ihre Tests sollen keine
// TCMS-Abhängigkeiten laden.
// =============================================================================

import type { TxClient } from '@taxtronik/db';

/**
 * Klassifikationen, die nie Nachweis werden (eigene Vernichtungs- bzw.
 * Zugriffsregeln). Dieselbe Liste prüfen der Guard der Verknüpfung beim
 * Anlegen und document_tcms_reference_scope_guard bei jeder Änderung.
 */
export const NACHWEIS_AUSGESCHLOSSEN = ['GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE'] as const;

/** Löschen gesperrt (Ablage, Bulk-Aktion). */
export const TCMS_NACHWEIS_LOESCHSPERRE =
  'Dieses Dokument ist im Tax-CMS verknüpft – als Nachweis einer Kontrolldurchführung oder als Anlage einer Ereignismeldung – und kann nicht gelöscht werden. Ein Nachweis wird frei, wenn er in der Durchführung entfernt ist; eine Anlage, wenn die Meldung verworfen ist.';

/** Neue Version gesperrt (Versions-Route). */
export const TCMS_NACHWEIS_VERSIONSSPERRE =
  'Dieses Dokument ist im Tax-CMS verknüpft (Nachweis oder Anlage einer Ereignismeldung); eine neue Version würde den Verweis verändern. Laden Sie die neue Fassung als eigenes Dokument hoch – bei einem Nachweis hängen Sie sie als weiteren Nachweis an.';

/** Umklassifizieren gesperrt (Ablage, RT3B-K-01). */
export const TCMS_NACHWEIS_UMKLASSIFIZIERUNGSSPERRE =
  'Dieses Dokument ist im Tax-CMS verknüpft (Nachweis oder Anlage einer Ereignismeldung). GwG-, Personal- und private Mitarbeiterunterlagen können kein Nachweis sein, und eine Umklassifizierung mit neuer Version würde den Verweis verändern. Die Umklassifizierung ist gesperrt, bis die Verknüpfung frei ist.';

/** GwG-Pflichtvernichtung gesperrt (Admin, RT3B-K-01). */
export const TCMS_NACHWEIS_VERNICHTUNGSSPERRE =
  'Dieses Dokument ist im Tax-CMS verknüpft (Nachweis einer Kontrolldurchführung oder Anlage einer Ereignismeldung) und wird nicht vernichtet, solange die Verknüpfung besteht. Es wurden keine Datei-Bytes gelöscht.';

/** Klassifikation, in die ein gebundenes Dokument nie wechseln darf. */
export function istNachweisAusgeschlossen(klassifikation: string): boolean {
  return (NACHWEIS_AUSGESCHLOSSEN as readonly string[]).includes(klassifikation);
}

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
