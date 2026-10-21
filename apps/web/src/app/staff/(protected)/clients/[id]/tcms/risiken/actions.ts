'use server';

// =============================================================================
// Aktionen des Risikoinventars (TCMS Stufe 3, portiert aus der Demo
// server/actions/risiken.ts): neu bewerten, Bewertung bestätigen,
// Übersteuerung beantragen und entscheiden (Vier-Augen), Freigabe einreichen
// bzw. erteilen (Vier-Augen), zurückweisen, Risikoakzeptanz anfordern.
//
// Jede Aktion läuft über tcmsKanzleiAktion (server/tcms/aktion.ts): Mandant
// als gebundenes erstes Argument, Akteur aus der Sitzung, Aufruf außerhalb der
// Transaktion, feste Fehlertexte. Bewertungen, Klassen, Vier-Augen und Status
// entscheidet der Dienst (TCMS-DIENST-001); die kanzleikonsole prüft nur die
// Form der Eingaben und – bei der Risikoakzeptanz – dass die Empfängerin ein
// aktiver Kontakt genau dieses Mandanten ist (TCMS-AKTEUR-001). Ob sie
// gesetzliche Vertreterin ist, prüft der Dienst an ihrer Rolle.
// =============================================================================

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import {
  GOVERNANCE_TYPEN,
  KLASSE_LABEL,
  KLASSEN,
  SCHAEDEN,
  WAHRSCHEINLICHKEITEN,
} from '@taxtronik/tcms-domain';
import { z } from 'zod';
import { parseFormData } from '@/server/actions/form-data';
import type { TcmsAktionsErgebnis } from '@/components/tcms/bereich-b/ergebnis';
import {
  BegruendungFeld,
  ObjektIdFeld,
  OptionaleBegruendungFeld,
} from '@/server/tcms/bereich-b/formular';
import { SICHT_LABEL } from '@/components/tcms/risiken/labels';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { freigabeEmpfaengerTx } from '@/server/tcms/personen';

const FELDER = {
  risikoId: 'risikoId',
  uebersteuerungId: 'uebersteuerungId',
  standId: 'standId',
  s: 's',
  w: 'w',
  r: 'r',
  gt: 'gt',
  sicht: 'sicht',
  klasse: 'klasse',
  entscheidung: 'entscheidung',
  risikoIds: 'risikoIds',
  empfaengerId: 'empfaengerId',
  begruendung: 'begruendung',
} as const;

// ---------------------------------------------------------------------------
// Neu bewerten / Bewertung bestätigen
// ---------------------------------------------------------------------------

const NeuBewertenFormular = z.object({
  risikoId: ObjektIdFeld,
  standId: ObjektIdFeld,
  s: z.enum(SCHAEDEN),
  w: z.enum(WAHRSCHEINLICHKEITEN),
  r: z.enum(['1', '2', '3']).transform((x) => Number(x) as 1 | 2 | 3),
  gt: z.enum(GOVERNANCE_TYPEN),
  begruendung: BegruendungFeld,
});

type NeuBewertung = {
  code: string;
  geaendert: boolean;
  brutto: { vorher: keyof typeof KLASSE_LABEL; nachher: keyof typeof KLASSE_LABEL };
  freigabe: { vorher: string; nachher: string };
  frequenzHinweise: string[];
  neuplanungen: Array<{ code: string; angelegt: string[]; entfernt: string[] }>;
};

/** Meldung zur Neubewertung aus der Antwort des Dienstes (Codes, Klassen, Neuplanung). */
function neuBewertungMeldung(e: NeuBewertung): string {
  const teile = [
    e.geaendert
      ? `${e.code} neu bewertet: Brutto ${KLASSE_LABEL[e.brutto.vorher]} → ${KLASSE_LABEL[e.brutto.nachher]}.${
          e.freigabe.vorher !== e.freigabe.nachher && e.freigabe.vorher !== 'IDENTIFIZIERT'
            ? ' Die geänderte Bewertung braucht eine Freigabe durch eine zweite Person.'
            : ''
        }`
      : `${e.code}: Bewertung unverändert bestätigt.`,
  ];
  if (e.frequenzHinweise.length > 0) teile.push(`Frequenz: ${e.frequenzHinweise.join('; ')}.`);
  for (const p of e.neuplanungen) {
    teile.push(
      `${p.code} neu geplant (${p.angelegt.length} angelegt, ${p.entfernt.length} entfernt).`,
    );
  }
  return teile.join(' ');
}

export async function risikoNeuBewertenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(NeuBewertenFormular, formData),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.risikoNeuBewerten, {
        params: { risikoId: d.risikoId },
        body: { standId: d.standId, s: d.s, w: d.w, r: d.r, gt: d.gt, begruendung: d.begruendung },
      });
      return { meldung: neuBewertungMeldung(daten) };
    },
  });
}

const BestaetigenFormular = z.object({
  risikoId: ObjektIdFeld,
  standId: ObjektIdFeld,
  begruendung: BegruendungFeld,
});

export async function risikoBewertungBestaetigenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(BestaetigenFormular, formData),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.risikoBewertungBestaetigen, {
        params: { risikoId: d.risikoId },
        body: { standId: d.standId, begruendung: d.begruendung },
      });
      return { meldung: neuBewertungMeldung(daten) };
    },
  });
}

// ---------------------------------------------------------------------------
// Übersteuerung (Vier-Augen)
// ---------------------------------------------------------------------------

const UebersteuernFormular = z.object({
  risikoId: ObjektIdFeld,
  sicht: z.enum(['DESIGN', 'BETRIEB']),
  klasse: z.enum(KLASSEN),
  begruendung: BegruendungFeld,
});

export async function uebersteuerungBeantragenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(UebersteuernFormular, formData),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.uebersteuerungBeantragen, {
        params: { risikoId: d.risikoId },
        body: { sicht: d.sicht, klasse: d.klasse, begruendung: d.begruendung },
      });
      return {
        meldung: `Übersteuerung beantragt (${SICHT_LABEL[daten.sicht]}: ${KLASSE_LABEL[daten.berechnet]} → ${KLASSE_LABEL[daten.klasse]}). Sie gilt erst nach Freigabe durch eine zweite Person.`,
      };
    },
  });
}

const EntscheidenFormular = z
  .object({
    uebersteuerungId: ObjektIdFeld,
    entscheidung: z.enum(['FREIGEBEN', 'ABLEHNEN']),
    begruendung: OptionaleBegruendungFeld,
  })
  .superRefine((e, ctx) => {
    // Wie der Vertrag (`ablehnungBegruendet`): eine Ablehnung braucht eine Begründung.
    if (e.entscheidung === 'ABLEHNEN' && !e.begruendung) {
      ctx.addIssue({ code: 'custom', path: ['begruendung'], message: 'Pflichtfeld.' });
    }
  });

export async function uebersteuerungEntscheidenAction(
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
      const { daten } = await dienst.rufe(ENDPUNKTE.uebersteuerungEntscheiden, {
        params: { uebersteuerungId: d.uebersteuerungId },
        body: {
          entscheidung: d.entscheidung,
          ...(d.begruendung ? { begruendung: d.begruendung } : {}),
        },
      });
      return {
        meldung:
          daten.status === 'FREIGEGEBEN'
            ? 'Übersteuerung freigegeben. Der berechnete Wert bleibt sichtbar.'
            : 'Übersteuerung abgelehnt.',
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Freigabe des Inventars (Vier-Augen)
// ---------------------------------------------------------------------------

/** Höchstzahl je Schritt wie im Vertrag (`MAX_RISIKEN_JE_SCHRITT`). */
const MAX_RISIKEN_JE_SCHRITT = 200;

const Schritt = z.enum(['einreichen', 'freigeben']);
const SchrittFeld = z.object({ schritt: Schritt });

const FreigabeSchrittFormular = z.object({
  schritt: Schritt,
  // Fehler am Feld `risikoIds` (nicht je Eintrag), damit die Auswahl ihn zeigt.
  risikoIds: z
    .array(z.string())
    .min(1, 'Bitte mindestens ein Risiko auswählen.')
    .max(MAX_RISIKEN_JE_SCHRITT)
    .refine((ids) => ids.every((id) => ObjektIdFeld.safeParse(id).success), 'Ungültige Auswahl.')
    .transform((ids) => [...new Set(ids)]),
});

export async function risikenFreigabeSchrittAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  // Nur Auswahl des festen Texts bei 403; der Schritt selbst wird unten geprüft.
  const schritt = parseFormData(SchrittFeld, formData, { absentAsNull: true });
  const freigeben = schritt.ok && schritt.data.schritt === 'freigeben';
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: freigeben ? 'VIER_AUGEN' : 'BEARBEITEN',
    felder: FELDER,
    parse: () =>
      parseFormData(FreigabeSchrittFormular, formData, {
        repeatable: ['risikoIds'],
        absentAsNull: true,
      }),
    aufruf: async (dienst, d) => {
      const endpunkt =
        d.schritt === 'freigeben'
          ? ENDPUNKTE.risikenFreigeben
          : ENDPUNKTE.risikenFreigabeEinreichen;
      const { daten } = await dienst.rufe(endpunkt, { body: { risikoIds: d.risikoIds } });
      const was = d.schritt === 'freigeben' ? 'freigegeben' : 'zur Freigabe eingereicht';
      const wer =
        daten.bearbeitet.length === 1
          ? daten.bearbeitet[0]!.code
          : `${daten.bearbeitet.length} Risiken`;
      const uebersprungen = daten.uebersprungen.length
        ? ` Übersprungen: ${daten.uebersprungen.map((u) => `${u.code} (${u.grund})`).join(', ')}.`
        : '';
      return { meldung: `${wer} ${was}.${uebersprungen}` };
    },
  });
}

const ZurueckweisenFormular = z.object({
  risikoId: ObjektIdFeld,
  begruendung: BegruendungFeld,
});

export async function risikoZurueckweisenAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'VIER_AUGEN',
    felder: FELDER,
    parse: () => parseFormData(ZurueckweisenFormular, formData),
    aufruf: async (dienst, d) => {
      const { daten } = await dienst.rufe(ENDPUNKTE.risikoZurueckweisen, {
        params: { risikoId: d.risikoId },
        body: { begruendung: d.begruendung },
      });
      return { meldung: `${daten.code} zurückgewiesen – Status wieder „bewertet“.` };
    },
  });
}

// ---------------------------------------------------------------------------
// Risikoakzeptanz beim Mandanten anfordern
// ---------------------------------------------------------------------------

const AkzeptanzFormular = z.object({
  risikoId: ObjektIdFeld,
  empfaengerId: z.uuid(),
  begruendung: BegruendungFeld,
});

export async function risikoakzeptanzAnfordernAction(
  mandantId: string,
  _vorher: TcmsAktionsErgebnis | null,
  formData: FormData,
): Promise<TcmsAktionsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: FELDER,
    parse: () => parseFormData(AkzeptanzFormular, formData),
    // Empfängerin: aktiver Kontakt genau dieses Mandanten mit aktivem
    // Portalzugang (kk-tcms-s11); Name aus der kanzleikonsole (Meldung), nie
    // aus dem Formular.
    vorbereiten: (tx, k, d) =>
      freigabeEmpfaengerTx(tx, { tenantId: k.g.tenantId, mandantId }, d.empfaengerId, {
        feld: 'empfaengerId',
      }),
    aufruf: async (dienst, d, kontakt) => {
      await dienst.rufe(ENDPUNKTE.risikoakzeptanzAnfordern, {
        params: { risikoId: d.risikoId },
        body: { empfaengerId: kontakt.id, begruendung: d.begruendung },
      });
      return {
        meldung: `Risikoakzeptanz bei ${kontakt.name} angefordert (Portal, Bestätigung per E-Mail-Code).`,
      };
    },
  });
}
