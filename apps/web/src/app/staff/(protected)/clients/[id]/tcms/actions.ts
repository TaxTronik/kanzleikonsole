'use server';

// =============================================================================
// Aktionen des Tax-CMS-Cockpits (TCMS Stufe 3). Mandant im Tax-CMS anlegen
// bzw. Stammdaten abgleichen (`PUT /v1/mandanten/:mandantId`): Name,
// Rechtsform und DATEV-Nr. kommen aus der kanzleikonsole (server/tcms/mandant.ts),
// nicht aus dem Formular. Wer anlegen darf (Admin/Partner, zuständige
// Berufsträgerin, Hauptbearbeitung), entscheidet der Dienst; die Oberfläche
// zeigt die Aktion und bildet die Antwort ab.
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import type { ActionResult } from '@/server/actions/types';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { mandantAnkerTx } from '@/server/tcms/mandant';

export type MandantAnkerErgebnis = ActionResult & { angelegt?: boolean; geaendert?: boolean };

export async function mandantImTcmsAnlegenAction(
  mandantId: string,
  _vorher: MandantAnkerErgebnis | null,
  _formData: FormData,
): Promise<MandantAnkerErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    vorbereiten: (tx, k) => mandantAnkerTx(tx, k.g.tenantId, mandantId),
    aufruf: async (dienst, _daten, anker) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.mandantAnkerSetzen, { body: anker });
      return { angelegt: daten.angelegt, geaendert: daten.geaendert };
    },
  });
}
