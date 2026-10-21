import 'server-only';

// =============================================================================
// n8n-Ereignis `document.uploaded` für Dokumente, die im Tax-CMS-Kontext
// abgelegt werden (kk-tcms-s11 Punkt 5): Nachweise einer Durchführung (Kanzlei
// und Kontrollaufgabe im Portal, Quelle `tcms-nachweis`) und Anlagen einer
// Ereignismeldung im Portal (Quelle `tcms-meldung`). Sie lösen dasselbe
// Ereignis aus wie jeder andere Upload – mit denselben Schlüsseln wie die
// Upload-Routen (`tenantId`, `documentId`, `clientId`, `classification`,
// `isGobd`) und der Quelle. Nie im Ereignis: Titel bzw. Dateiname, Inhalt,
// IDs oder Texte des Tax-CMS (Durchführung, Ereignis, Meldung).
//
// Erst nach dem Commit der Ablage (außerhalb jeder Transaktion); ein Fehler der
// Outbox bricht den abgeschlossenen Upload nicht ab (emitN8nEvent protokolliert
// und liefert WRITE_FAILED). Der Dedupe-Schlüssel je Dokument verhindert
// doppelte Ereignisse bei einer Wiederholung.
// =============================================================================

import { isGobdClassification } from '@taxtronik/storage';
import { emitN8nEvent } from '@/server/n8n/emit';

export type TcmsUploadQuelle = 'tcms-nachweis' | 'tcms-meldung';

export async function tcmsDokumentHochgeladen(a: {
  tenantId: string;
  mandantId: string;
  dokumentId: string;
  classification: string;
  quelle: TcmsUploadQuelle;
}): Promise<void> {
  await emitN8nEvent(
    'document.uploaded',
    {
      tenantId: a.tenantId,
      documentId: a.dokumentId,
      classification: a.classification,
      clientId: a.mandantId,
      isGobd: isGobdClassification(a.classification),
      source: a.quelle,
    },
    { tenantId: a.tenantId, dedupeKey: `document.uploaded:${a.dokumentId}` },
  );
}
