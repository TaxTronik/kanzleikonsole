'use server';

// =============================================================================
// Kommunikation des Tax-CMS (TCMS Stufe 3, Bereich A): offene Freigabe- oder
// Kenntnisnahme-Anforderung an eine andere (oder dieselbe) Person des
// Mandanten richten (`POST …/freigaben/:freigabeId/neuadressierung`, TS-06).
// Ein ausgestellter Code verfällt, die Fehlversuche beginnen neu; die Person
// erhält eine Nachricht über den Postausgang.
//
// Empfänger nur als aktiver Kontakt genau dieses Mandanten
// (server/tcms/personen.ts); ob die Rolle passt (Freigabe: gesetzliche
// Vertretung, Kenntnisnahme: aktive Rolle), entscheidet der Dienst.
// =============================================================================

import { z } from 'zod';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import { parseFormData } from '@/server/actions/form-data';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { mandantKontakteTx } from '@/server/tcms/personen';

const Formular = z.object({
  freigabeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ungültige Auswahl.'),
  empfaengerId: z.uuid('Bitte wählen Sie die Empfängerin oder den Empfänger.'),
});

export async function freigabeNeuadressierenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { empfaengerId: 'empfaengerId' },
    parse: () => parseFormData(Formular, formData, { absentAsNull: true }),
    vorbereiten: async (tx, k, daten) => {
      const [kontakt] = await mandantKontakteTx(
        tx,
        { tenantId: k.g.tenantId, mandantId },
        [daten.empfaengerId],
        { feld: 'empfaengerId' },
      );
      return kontakt!;
    },
    aufruf: async (dienst, { freigabeId }, kontakt) => {
      await dienst.rufe(ENDPUNKTE.freigabeNeuadressieren, {
        params: { freigabeId },
        body: { empfaengerId: kontakt.id },
      });
      return {
        meldung: `Die Anforderung ist jetzt an ${kontakt.name} adressiert; ein ausgestellter Code ist verfallen.`,
      };
    },
  });
}
