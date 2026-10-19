'use server';

// =============================================================================
// Ereignis melden im Portal (TCMS Stufe 3, Bereich D; aus der Demo
// server/actions/portal-ereignis.ts).
//
// Mandant und Person nur aus der Portal-Sitzung. Melden dürfen gesetzliche
// Vertretung und Tax-Compliance-Beauftragte – das entscheidet das Tax-CMS
// (`melden` und `programmVorhanden` von `portalMeldungenLesen`, dieselbe Regel
// wie beim Erfassen, TCMS s7; vorher die ganze Portal-Übersicht). Die
// kanzleikonsole nimmt Anlagen erst NACH dieser Auskunft an (keine Dateien
// Unberechtigter in der Ablage), legt sie über die Portal-Dokumentenpipeline
// ab, bindet sie in derselben Transaktion (Löschsperre, TCMS-NACHWEIS-001,
// server/tcms/portal/meldung.ts) und übergibt nur Verweise der gespeicherten
// Fassung. Wen die Kanzlei
// benachrichtigt (Hauptbearbeitung), kommt aus der kanzleikonsole – Name aus
// der Datenbank, nie aus dem Formular; er begründet kein Recht.
// =============================================================================

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ENDPUNKTE, PortalMeldungBodySchema } from '@taxtronik/tcms-contract';
import { formFlag, parseFormData } from '@/server/actions/form-data';
import type { ActionFailure } from '@/server/actions/action-runner';
import type { ActionResult } from '@/server/actions/types';
import { tcmsPortalAktion } from '@/server/tcms/aktion';
import { ansprechpersonenTx } from '@/server/tcms/portal/ansprechpartner';
import { dateiSha256, portalAblageKontext, portalDateienFeld } from '@/server/tcms/portal/anlagen';
import { meldungErfassenUndBinden, meldungsAnlagenAblegen } from '@/server/tcms/portal/meldung';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';

type Ergebnis = ActionResult & { meldung?: string };

const MeldungFormular = z.object({
  typ: PortalMeldungBodySchema.shape.typ,
  titel: PortalMeldungBodySchema.shape.titel,
  beschreibung: PortalMeldungBodySchema.shape.beschreibung,
  datum: PortalMeldungBodySchema.shape.datum,
  zusage: formFlag('1'),
  anlagen: portalDateienFeld({ pflicht: false }),
});

const KEIN_PROGRAMM =
  'Für Ihr Unternehmen ist noch kein Tax-CMS eingerichtet. Bitte wenden Sie sich an Ihre Kanzlei.';

export async function portalEreignisMeldenAction(
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  const ergebnis = await tcmsPortalAktion({
    keinRecht: 'PORTAL_ROLLE',
    felder: {
      typ: 'typ',
      titel: 'titel',
      beschreibung: 'beschreibung',
      datum: 'datum',
      anlagen: 'anlagen',
    },
    parse: () => parseFormData(MeldungFormular, formData, { repeatable: ['anlagen'] }),
    vorbereiten: async (tx, k) => {
      const ablage = await portalAblageKontext(k.g);
      const { hauptbearbeitung } = await ansprechpersonenTx(tx, {
        tenantId: k.g.tenantId,
        mandantId: k.mandantId,
      });
      return { ablage, benachrichtigen: hauptbearbeitung };
    },
    aufruf: async (dienst, d, v): Promise<ActionFailure | { nummer: string }> => {
      // Recht und Programm laut Dienst, bevor eine Datei angenommen wird.
      const { daten: m } = await dienst.rufe(ENDPUNKTE.portalMeldungenLesen);
      if (!m.programmVorhanden) {
        return { ok: false, error: KEIN_PROGRAMM, errorCode: 'FORBIDDEN' };
      }
      if (!m.melden) {
        return { ok: false, error: TCMS_KEIN_RECHT.PORTAL_ROLLE, errorCode: 'FORBIDDEN' };
      }
      const hashes = await Promise.all(d.anlagen.map((datei) => dateiSha256(datei)));
      if (new Set(hashes).size !== hashes.length) {
        return {
          ok: false,
          error: 'Bitte prüfen Sie die markierten Angaben.',
          errorCode: 'VALIDATION_ERROR',
          fieldErrors: { anlagen: ['Eine Datei ist doppelt ausgewählt.'] },
        };
      }
      const { anlagen, verknuepfungen } = await meldungsAnlagenAblegen(v.ablage, d.anlagen);
      const r = await meldungErfassenUndBinden(
        dienst,
        v.ablage.ctx,
        {
          typ: d.typ,
          titel: d.titel,
          beschreibung: d.beschreibung,
          datum: d.datum,
          anlagen,
          zusageAenderungen: d.zusage,
          benachrichtigen: v.benachrichtigen,
        },
        verknuepfungen,
      );
      return { nummer: r.nummer };
    },
  });
  if (!ergebnis.ok) return ergebnis;
  // Navigation erst nach Erfolg, außerhalb des Fehler-Mappings (K-02).
  redirect(`/portal/tcms/ereignis?gemeldet=${encodeURIComponent(ergebnis.nummer)}`);
}
