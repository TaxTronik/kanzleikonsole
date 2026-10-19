'use server';

// =============================================================================
// Kontakte & Tax-CMS-Rollen (TCMS Stufe 3): Rollen eines Mandantenkontakts im
// TCMS setzen (`PUT /v1/mandanten/:mandantId/kontakte`). Nur Kontakte DIESES
// Mandanten (server/tcms/personen.ts); Rollen zuweisen nur aktiven Kontakten,
// Rollen entfernen (leere Auswahl) auch bei inaktiven. Wer Rollen pflegen
// darf, entscheidet der Dienst (kannBearbeiten).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { z } from 'zod';
import { parseFormData } from '@/server/actions/form-data';
import type { ActionResult } from '@/server/actions/types';
import { istKontaktRolle, TCMS_KONTAKT_ROLLEN } from '@/components/tcms/rollen';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { mandantKontakteTx } from '@/server/tcms/personen';

const RollenFormular = z.object({
  kontaktId: z.uuid(),
  // Fehler am Feld selbst (nicht `rollen.0`), damit das Formular sie zeigt.
  rollen: z
    .array(z.string())
    .max(TCMS_KONTAKT_ROLLEN.length)
    .default([])
    .refine((werte) => werte.every(istKontaktRolle), 'Bitte nur angebotene Rollen wählen.')
    .transform((werte) => werte.filter(istKontaktRolle)),
  funktion: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((wert) => (wert ? wert : null)),
});

export async function kontaktRollenSetzenAction(
  mandantId: string,
  _vorher: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { rollen: 'rollen', funktion: 'funktion', kontaktId: 'kontaktId' },
    parse: () =>
      parseFormData(RollenFormular, formData, { repeatable: ['rollen'], absentAsNull: true }),
    vorbereiten: async (tx, k, daten) => {
      const [kontakt] = await mandantKontakteTx(
        tx,
        { tenantId: k.g.tenantId, mandantId },
        [daten.kontaktId],
        { feld: 'kontaktId', auchInaktive: daten.rollen.length === 0 },
      );
      return kontakt!.id;
    },
    aufruf: async (dienst, daten, kontaktId) => {
      await dienst.rufe(ENDPUNKTE.kontaktRollenSetzen, {
        body: {
          kontaktId,
          rollen: [...new Set(daten.rollen)],
          funktion: daten.rollen.length > 0 ? daten.funktion : null,
        },
      });
    },
  });
}
