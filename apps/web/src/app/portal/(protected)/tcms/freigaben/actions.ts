'use server';

// =============================================================================
// Freigaben und Kenntnisnahmen im Portal (TCMS Stufe 3, Bereich D; aus der Demo
// server/actions/freigaben.ts).
//
// Wer freigeben darf (nur die adressierte Person, mit Code nur eine aktive
// gesetzliche Vertretung – TS-06), Codes (Erzeugung, Frist, Fehlversuche unter
// Sperre) und die Snapshot-Prüfung liegen im Tax-CMS. Die Seite fordert den
// Code an (Zustellung über den Postausgang des Tax-CMS) und nimmt ihn
// entgegen. Schutzregel: Der Code erscheint in keinem Ergebnis, keiner Meldung
// und keinem Log der kanzleikonsole (feste Texte; Protokoll nur
// Klassifikationen, server/tcms/zustand.ts) und wird nicht zwischengespeichert.
// =============================================================================

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ENDPUNKTE, FreigabeCodeSchema, ObjektIdSchema } from '@taxtronik/tcms-contract';
import { isoZeitText } from '@/components/tcms/format';
import { codeFehlerText } from '@/components/tcms/portal/texte';
import { formFlag, parseActionInput, parseFormData } from '@/server/actions/form-data';
import type { ActionFailure } from '@/server/actions/action-runner';
import type { ActionResult } from '@/server/actions/types';
import { tcmsPortalAktion } from '@/server/tcms/aktion';

type Ergebnis = ActionResult & { meldung?: string };
/** Rückgabe des Dienstaufrufs: Fehlerergebnis oder Meldung (Nutzlast). */
type Lauf = ActionFailure | { meldung?: string; warnung?: string };

const NICHT_GEFUNDEN = 'Anforderung nicht gefunden. Bitte laden Sie die Seite neu.';
const Freigabe = z.object({ freigabeId: ObjektIdSchema });

/** Nach Erfolg: zur Liste mit Bestätigung (außerhalb des Fehler-Mappings, K-02). */
function zurListe(freigabeId: string): never {
  redirect(`/portal/tcms/freigaben?erledigt=${encodeURIComponent(freigabeId)}`);
}

export async function portalFreigabeCodeAnfordernAction(
  freigabeId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsPortalAktion({
    keinRecht: 'PORTAL_ZUGEORDNET',
    parse: () => parseActionInput(Freigabe, { freigabeId }, NICHT_GEFUNDEN),
    aufruf: async (dienst, p): Promise<Lauf> => {
      const { daten } = await dienst.rufe(ENDPUNKTE.portalFreigabeCodeAnfordern, { params: p });
      return {
        meldung: `Ein neuer Bestätigungscode wird an Ihre E-Mail-Adresse gesendet. Er ist gültig bis ${isoZeitText(daten.codeAblauf)}.`,
      };
    },
  });
}

/** Nur der Code (genau sechs Ziffern); Leerraum um den Code wird entfernt. */
const CodeFormular = z.object({
  code: z.preprocess((wert) => (typeof wert === 'string' ? wert.trim() : wert), FreigabeCodeSchema),
});

export async function portalFreigebenAction(
  freigabeId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  const ergebnis = await tcmsPortalAktion({
    keinRecht: 'PORTAL_ZUGEORDNET',
    felder: { code: 'code' },
    parse: () => {
      const p = parseActionInput(Freigabe, { freigabeId }, NICHT_GEFUNDEN);
      if (!p.ok) return p;
      const f = parseFormData(CodeFormular, formData, {
        errorMessage: 'Bitte geben Sie den 6-stelligen Code aus der E-Mail ein.',
      });
      return f.ok ? { ok: true, data: { ...p.data, code: f.data.code } } : f;
    },
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.portalFreigabeErteilen, {
        params: { freigabeId: d.freigabeId },
        body: { code: d.code },
      });
      // Falscher Code ist eine Antwort, kein Fehler (Fehlversuch gezählt): nur Grund und Rest.
      return daten.freigegeben
        ? { freigegeben: true as const }
        : {
            freigegeben: false as const,
            grund: daten.grund,
            verbleibend: daten.verbleibendeVersuche,
          };
    },
  });
  if (!ergebnis.ok) return ergebnis;
  if (!ergebnis.freigegeben) {
    return {
      ok: false,
      error: codeFehlerText(ergebnis.grund, ergebnis.verbleibend),
      errorCode: 'VALIDATION_ERROR',
    };
  }
  zurListe(freigabeId);
}

const KenntnisFormular = z.object({
  gelesen: formFlag(
    'on',
    z.literal(true, 'Bitte bestätigen Sie, dass Sie das Dokument gelesen haben.'),
  ),
});

export async function portalKenntnisnahmeAction(
  freigabeId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  const ergebnis = await tcmsPortalAktion({
    keinRecht: 'PORTAL_ZUGEORDNET',
    felder: { gelesen: 'gelesen' },
    parse: () => {
      const p = parseActionInput(Freigabe, { freigabeId }, NICHT_GEFUNDEN);
      if (!p.ok) return p;
      const f = parseFormData(KenntnisFormular, formData, { absentAsNull: true });
      return f.ok ? { ok: true, data: p.data } : f;
    },
    aufruf: async (dienst, p) => {
      await dienst.rufe(ENDPUNKTE.portalKenntnisnahmeBestaetigen, {
        params: p,
        body: { gelesen: true },
      });
    },
  });
  if (!ergebnis.ok) return ergebnis;
  zurListe(freigabeId);
}
