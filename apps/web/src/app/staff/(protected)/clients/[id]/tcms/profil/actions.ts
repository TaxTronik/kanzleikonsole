'use server';

// =============================================================================
// Geschäftsprofil des Tax-CMS (TCMS Stufe 3, Bereich A; Demo
// server/actions/profil.ts):
//   - Profil ändern (`POST …/profil`): neuer Profilstand auf dem gesehenen
//     offenen Stand (`profilStandId`, sonst Konflikt), Gültig-ab-Datum und
//     Ereignisse – Prüfung, Neubewertung und Ereignisse übernimmt der Dienst.
//   - Vorgeschlagenes Risiko aufnehmen (`POST …/profil/risiko-aufnehmen`):
//     Verantwortliche (Berufsträger:in, Hauptbearbeitung, Vertretung) mit
//     Namen aus der kanzleikonsole, nie aus dem Formular; nur Vorbelegung
//     neuer Kontrollen, keine Rechte.
// Nach Erfolg zurück aufs Profil mit einer festen Meldung (Zahlen bzw. Codes
// aus der Antwort, auf der Seite erneut geprüft).
// =============================================================================

import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  ENDPUNKTE,
  parseJsonStrikt,
  ProfilAntwortenSchema,
  StandSchema,
  type ProfilAntworten,
} from '@taxtronik/tcms-contract';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import type { ActionParseResult } from '@/server/actions/action-runner';
import { formFlag, parseActionInput, parseFormData } from '@/server/actions/form-data';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import {
  aufnahmeVerantwortliche,
  tcmsZustaendigkeitTx,
} from '@/server/tcms/programm/zustaendigkeit';

const OBJEKT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RISIKO_CODE = /^EC-[A-Z]{3}-\d{2}$/;
const MAX_PROFIL = 100_000;

const AendernFormular = z.object({
  profilStandId: z.string().regex(OBJEKT_ID, 'Ungültige Auswahl.'),
  profil: z.string().min(2).max(MAX_PROFIL),
  gueltigAb: StandSchema,
  ereignisse: formFlag(),
});

interface Aenderung {
  profilStandId: string;
  profil: ProfilAntworten;
  gueltigAb: string;
  ereignisseAnlegen: boolean;
}

function aenderungAus(formData: FormData): ActionParseResult<Aenderung> {
  const f = parseFormData(AendernFormular, formData, { absentAsNull: true });
  if (!f.ok) return f;
  const json = parseJsonStrikt(new TextEncoder().encode(f.data.profil));
  if (!json.ok) {
    return {
      ok: false,
      error: 'Das Profil konnte nicht gelesen werden. Bitte laden Sie die Seite neu.',
      errorCode: 'VALIDATION_ERROR',
    };
  }
  const profil = parseActionInput(ProfilAntwortenSchema, json.wert);
  if (!profil.ok) {
    return { ...profil, fieldErrors: { profil: ['Bitte prüfen Sie die Angaben des Profils.'] } };
  }
  return {
    ok: true,
    data: {
      profilStandId: f.data.profilStandId,
      profil: profil.data,
      gueltigAb: f.data.gueltigAb,
      ereignisseAnlegen: f.data.ereignisse,
    },
  };
}

function profilHref(mandantId: string, query: Record<string, string>, anker: string): string {
  return `/staff/clients/${encodeURIComponent(mandantId)}/tcms/profil?${new URLSearchParams(query).toString()}#${anker}`;
}

export async function profilAendernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  const ergebnis = await tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { gueltigAb: 'gueltigAb', profil: 'profil', profilStandId: 'profil' },
    parse: () => aenderungAus(formData),
    aufruf: async (dienst, daten) => {
      const { daten: neu } = await dienst.rufe(ENDPUNKTE.profilAendern, { body: daten });
      return {
        nb: neu.neuBewerten.length,
        ev: neu.ereignisse.length,
        nv: neu.neuVorgeschlagen.length,
      };
    },
  });
  if (ergebnis.ok) {
    redirect(
      profilHref(
        mandantId,
        {
          geaendert: '1',
          nb: String(ergebnis.nb),
          ev: String(ergebnis.ev),
          nv: String(ergebnis.nv),
        },
        'historie',
      ),
    );
  }
  return ergebnis;
}

const AufnehmenFormular = z.object({ code: z.string().regex(RISIKO_CODE, 'Ungültige Auswahl.') });

export async function risikoAufnehmenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  const ergebnis = await tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { code: 'code' },
    parse: () => parseFormData(AufnehmenFormular, formData),
    vorbereiten: async (tx, k) =>
      aufnahmeVerantwortliche(
        await tcmsZustaendigkeitTx(tx, { tenantId: k.g.tenantId, mandantId }),
      ),
    aufruf: async (dienst, daten, verantwortliche) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.profilRisikoAufnehmen, {
        body: { code: daten.code, verantwortliche },
      });
      return {
        code: r.code,
        kn: r.neueKontrollen.join(','),
        vk: r.verknuepft.join(','),
        ng: r.neuGeplant.map((n) => n.code).join(','),
        d: r.durchfuehrungen,
      };
    },
  });
  if (ergebnis.ok) {
    redirect(
      profilHref(
        mandantId,
        {
          aufgenommen: ergebnis.code,
          ...(ergebnis.kn ? { kn: ergebnis.kn } : {}),
          ...(ergebnis.vk ? { vk: ergebnis.vk } : {}),
          ...(ergebnis.ng ? { ng: ergebnis.ng } : {}),
          d: String(ergebnis.d),
        },
        'vorschlaege',
      ),
    );
  }
  return ergebnis;
}
