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
// Seite gilt, steht an der Kontrolle im Dienst; die Seite sendet die gelesene
// Seite (`partei`) mit, die Aktion prüft die Personen für genau diese Seite,
// und der Dienst prüft sie unter der Zeilensperre gegen den Kontrollstand
// (TCMS s7: abweichend → 409). Ein manipuliertes Formular kann so keinen
// Mandantenkontakt als Kanzleiperson eintragen; den früheren Vorab-Read
// braucht es nicht mehr.
// =============================================================================

import { TcmsKonflikt } from '@taxtronik/tcms-client';
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
    keinRecht: 'VIER_AUGEN',
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

const ZustaendigkeitFormular = z
  .object({
    ...Kontrolle,
    /** Seite der Kontrolle aus der gelesenen Antwort; der Dienst prüft sie unter der Sperre. */
    partei: z.enum(['KANZLEI', 'MANDANT']),
    durchfuehrendId: z.uuid(),
    vertretungId: z.uuid(),
    gegenzeichnerId: formEmpty(null, z.uuid().nullable()),
    gegenzeichnungMandant: HakenFeld,
  })
  .superRefine((e, ctx) => {
    // Gegenzeichnung beim Mandanten gibt es nur an Kontrollen des Mandanten
    // (Vertrag, TCMS s7). Die Seite bietet den Haken auf der Kanzleiseite nicht
    // an; ein Formular, das ihn trotzdem sendet, erreicht den Dienst nicht.
    if (e.gegenzeichnungMandant && e.partei !== 'MANDANT') {
      ctx.addIssue({
        code: 'custom',
        path: ['gegenzeichnungMandant'],
        message: 'Nur bei Kontrollen des Mandanten möglich.',
      });
    }
  });

/** 409 des Dienstes: Seite oder Stand der Kontrolle weichen vom gelesenen ab (TS-05). */
const ZUSTAENDIGKEIT_KONFLIKT =
  'Die Kontrolle wurde zwischenzeitlich geändert. Bitte laden Sie die Seite neu und prüfen Sie die Zuständigkeiten.';

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
      try {
        const { daten } = await dienst.rufe(ENDPUNKTE.verantwortlicheAendern, {
          params: { kontrolleId: d.kontrolleId },
          body: {
            standId: d.standId,
            partei: d.partei,
            durchfuehrendId: personen.durchfuehrendId,
            vertretungId: personen.vertretungId,
            gegenzeichnerId: personen.gegenzeichnerId,
            gegenzeichnungMandant: d.gegenzeichnungMandant,
          },
        });
        return { meldung: geaendertMeldung('Zuständigkeiten gespeichert.', daten) };
      } catch (fehler) {
        if (fehler instanceof TcmsKonflikt) {
          return {
            ok: false as const,
            error: ZUSTAENDIGKEIT_KONFLIKT,
            errorCode: 'CONFLICT' as const,
          };
        }
        throw fehler;
      }
    },
  });
}
