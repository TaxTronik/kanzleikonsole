'use server';

// =============================================================================
// Aktionen der Kontrollmatrix (TCMS Stufe 3, portiert aus der Demo
// server/actions/kontrollen.ts): Designbeurteilung, Frequenzabweichung
// beantragen, entscheiden (Vier-Augen) und aufheben, Zuständigkeiten ändern.
//
// Frequenzen, Vier-Augen und Pflichtangaben entscheidet der Dienst
// (TCMS-DIENST-001). Die kanzleikonsole prüft bei den Zuständigkeiten jede
// Person aus dem Formular (TCMS-AKTEUR-001): Kanzleiseite = aktive
// Mitarbeitende mit Zugriff auf den Mandanten, Mandantenseite = aktive
// Kontakte genau dieses Mandanten, Gegenzeichnung = Kanzleiperson. Welche
// Seite gilt, steht an der Kontrolle im Dienst; die Aktion liest sie vor dem
// Schreiben nach und bricht ab, wenn sie nicht zur geprüften Seite passt –
// sonst könnte ein manipuliertes Formular einen Mandantenkontakt ohne Rolle
// als Kanzleiperson eintragen (der Dienst erkennt auf der Kanzleiseite nur
// Kontakte, die bei ihm eine Rolle haben).
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { frequenzLabel } from '@taxtronik/tcms-domain';
import { z } from 'zod';
import { formEmpty, parseFormData } from '@/server/actions/form-data';
import type { TcmsAktionsErgebnis } from '@/components/tcms/bereich-b/ergebnis';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import {
  BegruendungFeld,
  HakenFeld,
  ObjektIdFeld,
  OptionaleBegruendungFeld,
} from '@/server/tcms/bereich-b/formular';
import { kanzleiPersonenFuerMandantTx, mandantKontakteTx } from '@/server/tcms/personen';
import { TCMS_AKTION_TEXTE } from '@/server/tcms/zustand';

const FELDER = {
  kontrolleId: 'kontrolleId',
  standId: 'standId',
  design: 'design',
  turnus: 'turnus',
  anlass: 'anlass',
  entscheidung: 'entscheidung',
  begruendung: 'begruendung',
  durchfuehrendId: 'durchfuehrendId',
  vertretungId: 'vertretungId',
  gegenzeichnerId: 'gegenzeichnerId',
  gegenzeichnungMandant: 'gegenzeichnungMandant',
} as const;

type Geaendert = {
  frequenz: { turnus: 'KEIN' | 'JAEHRLICH' | 'QUARTALSWEISE' | 'MONATLICH'; anlass: boolean };
  version: number;
  neuplanung: { code: string; angelegt: string[]; entfernt: string[] } | null;
};

function geaendertMeldung(text: string, e: Geaendert): string {
  const plan = e.neuplanung
    ? ` Künftige Durchführungen neu geplant (${e.neuplanung.angelegt.length} angelegt, ${e.neuplanung.entfernt.length} entfernt).`
    : '';
  return `${text} Neuer Kontrollstand v${e.version}, maßgebliche Frequenz: ${frequenzLabel(e.frequenz)}.${plan}`;
}

const Kontrolle = { kontrolleId: ObjektIdFeld, standId: ObjektIdFeld };

// ---------------------------------------------------------------------------
// Designbeurteilung
// ---------------------------------------------------------------------------

const DesignFormular = z.object({
  ...Kontrolle,
  // Gleichrangige Optionen ohne Vorauswahl: fehlt die Wahl, ist das ein Feldfehler.
  design: z.enum(['ANGEMESSEN', 'MANGEL']),
  begruendung: BegruendungFeld,
});

export async function kontrolleDesignBeurteilenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(DesignFormular, formData, { absentAsNull: true }),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.kontrolleDesignBeurteilen, {
        params: { kontrolleId: d.kontrolleId },
        body: { standId: d.standId, design: d.design, begruendung: d.begruendung },
      });
      return {
        meldung: geaendertMeldung(
          `Designbeurteilung „${d.design === 'ANGEMESSEN' ? 'angemessen' : 'Mangel'}“ dokumentiert.`,
          daten,
        ),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Frequenzabweichung (Vier-Augen)
// ---------------------------------------------------------------------------

const AbweichungFormular = z.object({
  ...Kontrolle,
  turnus: z.enum(['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH']),
  anlass: HakenFeld,
  begruendung: BegruendungFeld,
});

export async function frequenzAbweichungBeantragenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(AbweichungFormular, formData, { absentAsNull: true }),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.frequenzAbweichungBeantragen, {
        params: { kontrolleId: d.kontrolleId },
        body: {
          standId: d.standId,
          turnus: d.turnus,
          anlass: d.anlass,
          begruendung: d.begruendung,
        },
      });
      return {
        meldung: geaendertMeldung(
          `Frequenzabweichung beantragt (${frequenzLabel({ turnus: d.turnus, anlass: d.anlass })}); sie gilt erst nach Freigabe durch eine zweite Person.`,
          daten,
        ),
      };
    },
  });
}

const EntscheidenFormular = z
  .object({
    ...Kontrolle,
    entscheidung: z.enum(['FREIGEBEN', 'ABLEHNEN']),
    begruendung: OptionaleBegruendungFeld,
  })
  .superRefine((e, ctx) => {
    // Wie der Vertrag (`ablehnungBegruendet`): eine Ablehnung braucht eine Begründung.
    if (e.entscheidung === 'ABLEHNEN' && !e.begruendung) {
      ctx.addIssue({ code: 'custom', path: ['begruendung'], message: 'Pflichtfeld.' });
    }
  });

export async function frequenzAbweichungEntscheidenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'ZWEITE_PERSON',
    felder: FELDER,
    parse: () => parseFormData(EntscheidenFormular, formData, { absentAsNull: true }),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.frequenzAbweichungEntscheiden, {
        params: { kontrolleId: d.kontrolleId },
        body: {
          standId: d.standId,
          entscheidung: d.entscheidung,
          ...(d.begruendung ? { begruendung: d.begruendung } : {}),
        },
      });
      return {
        meldung: geaendertMeldung(
          d.entscheidung === 'FREIGEBEN'
            ? 'Frequenzabweichung freigegeben.'
            : 'Frequenzabweichung abgelehnt.',
          daten,
        ),
      };
    },
  });
}

const AufhebenFormular = z.object({ ...Kontrolle, begruendung: BegruendungFeld });

export async function frequenzAbweichungAufhebenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(AufhebenFormular, formData),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.frequenzAbweichungAufheben, {
        params: { kontrolleId: d.kontrolleId },
        body: { standId: d.standId, begruendung: d.begruendung },
      });
      return {
        meldung: geaendertMeldung(
          'Frequenzabweichung aufgehoben; es gilt wieder die abgeleitete Frequenz.',
          daten,
        ),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Zuständigkeiten
// ---------------------------------------------------------------------------

const ZustaendigkeitFormular = z.object({
  ...Kontrolle,
  /** Seite der Kontrolle laut Seite; vor dem Schreiben gegen den Dienst geprüft. */
  partei: z.enum(['KANZLEI', 'MANDANT']),
  durchfuehrendId: z.uuid(),
  vertretungId: z.uuid(),
  gegenzeichnerId: formEmpty(null, z.uuid().nullable()),
  gegenzeichnungMandant: HakenFeld,
});

export async function verantwortlicheAendernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(ZustaendigkeitFormular, formData, { absentAsNull: true }),
    vorbereiten: async (tx, k, d) => {
      const bezug = { tenantId: k.g.tenantId, mandantId };
      const seite = async (id: string, feld: 'durchfuehrendId' | 'vertretungId') =>
        d.partei === 'KANZLEI'
          ? (await kanzleiPersonenFuerMandantTx(tx, bezug, [id], { feld }))[0]!.id
          : (await mandantKontakteTx(tx, bezug, [id], { feld }))[0]!.id;
      const durchfuehrendId = await seite(d.durchfuehrendId, 'durchfuehrendId');
      const vertretungId = await seite(d.vertretungId, 'vertretungId');
      // Bei Gegenzeichnung beim Mandanten bestätigt die Vertretung (Vertrag:
      // dann keine gegenzeichnende Person); sonst nur eine Kanzleiperson.
      const gegenzeichnerId =
        d.gegenzeichnungMandant || d.gegenzeichnerId === null
          ? null
          : (
              await kanzleiPersonenFuerMandantTx(tx, bezug, [d.gegenzeichnerId], {
                feld: 'gegenzeichnerId',
              })
            )[0]!.id;
      return { durchfuehrendId, vertretungId, gegenzeichnerId };
    },
    aufruf: async (dienst, d, personen) => {
      // Die geprüfte Seite muss die der Kontrolle sein (sie ändert sich im
      // Dienst nicht); sonst nichts schreiben.
      const { daten: aktuell } = await dienst.rufe(ENDPUNKTE.kontrolleLesen, {
        params: { kontrolleId: d.kontrolleId },
      });
      if (aktuell.kontrolle.partei !== d.partei) {
        return {
          ok: false as const,
          error: TCMS_AKTION_TEXTE.konflikt,
          errorCode: 'CONFLICT' as const,
        };
      }
      const { daten } = await dienst.rufe(ENDPUNKTE.verantwortlicheAendern, {
        params: { kontrolleId: d.kontrolleId },
        body: {
          standId: d.standId,
          durchfuehrendId: personen.durchfuehrendId,
          vertretungId: personen.vertretungId,
          gegenzeichnerId: personen.gegenzeichnerId,
          gegenzeichnungMandant: d.gegenzeichnungMandant,
        },
      });
      return { meldung: geaendertMeldung('Zuständigkeiten gespeichert.', daten) };
    },
  });
}
