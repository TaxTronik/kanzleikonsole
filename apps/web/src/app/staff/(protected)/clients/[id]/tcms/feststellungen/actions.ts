'use server';

// =============================================================================
// Feststellungen und Maßnahmen (TCMS Stufe 3, Bereich C; portiert aus der Demo
// server/actions/feststellungen.ts). Jede Aktion läuft über tcmsKanzleiAktion:
// Mandant und Objekt sind gebunden (`aktion.bind(null, mandantId, id)`), der
// Akteur prüft den Mandantenzugriff. Rechte, Vier-Augen, §-153-Regeln und
// Vertraulichkeit entscheidet der Dienst; die Aktion prüft nur die Form der
// Eingaben (Vertrag) und Personen über server/tcms/personen.ts.
// =============================================================================

import { TcmsKonflikt, TcmsUngueltig } from '@taxtronik/tcms-client';
import {
  AuswirkungSchema,
  ENDPUNKTE,
  ErklaerungBodySchema,
  FeststellungErfassenBodySchema,
  FeststellungKlasseSchema,
  FeststellungQuelleSchema,
  FeststellungStatusSchema,
  freitext,
  ObjektIdSchema,
  P153EntscheidungSchema,
  SchwereSchema,
  TagSchema,
} from '@taxtronik/tcms-contract';
import { FESTSTELLUNG_STATUS_LABEL, P153_LABEL } from '@taxtronik/tcms-domain';
import { z } from 'zod';
import { parseDezimal } from '@/components/tcms/durchfuehrung/werte';
import type { TcmsErgebnis } from '@/components/tcms/durchfuehrung/formulare';
import { ActionError } from '@/server/actions/action-error';
import type { ActionFailure } from '@/server/actions/action-runner';
import { parseFormData } from '@/server/actions/form-data';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { personAusWert } from '@/server/tcms/feststellungen/personen';
import { WEITER_KONFLIKT, weiterGesperrtText } from '@/server/tcms/feststellungen/weiter';
import { kanzleiPersonenFuerMandantTx, mandantKontakteTx } from '@/server/tcms/personen';

type Ausgang = { meldung: string } | ActionFailure;

/** Gebundene Objekt-ID; ungültig → feste Meldung, kein Dienstaufruf. */
function objekt(id: string, meldung = 'Feststellung nicht gefunden.'): string {
  const geprueft = ObjektIdSchema.safeParse(id);
  if (!geprueft.success) throw new ActionError(meldung);
  return geprueft.data;
}

const leerAlsUndefined = (wert: unknown) => (wert === '' || wert === null ? undefined : wert);
const leerAlsNull = (wert: unknown) => (wert === '' || wert === undefined ? null : wert);

// ---------------------------------------------------------------------------
// Erfassen
// ---------------------------------------------------------------------------

const ErfassenFormular = z
  .object({
    // Einzeilig wie im Vertrag (TCMS s8): unzulässige Zeichen, auch CR/LF,
    // als Feldfehler mit dem Text des Vertrags.
    titel: FeststellungErfassenBodySchema.shape.titel,
    sachverhalt: freitext(20, 4000),
    quelle: FeststellungQuelleSchema,
    // Angabe zur Quelle: eine Bezeichnung, einzeilig wie im Vertrag (TCMS s10).
    quelleText: FeststellungErfassenBodySchema.shape.quelleText,
    durchfuehrungId: z.preprocess(leerAlsUndefined, ObjektIdSchema.optional()),
    klasse: FeststellungKlasseSchema,
    schwere: SchwereSchema,
    auswirkung: AuswirkungSchema,
    risiken: z
      .array(ObjektIdSchema)
      .max(100)
      .default([])
      .transform((ids) => [...new Set(ids)]),
  })
  // Wie die Demo: Die Durchführung zählt nur bei Quelle „Kontrolle“.
  .transform(({ risiken, durchfuehrungId, ...rest }) => ({
    ...rest,
    ...(rest.quelle === 'KONTROLLE' && durchfuehrungId ? { durchfuehrungId } : {}),
    risikoIds: risiken,
  }));

export async function feststellungErfassenAction(
  mandantId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: {
      titel: 'titel',
      sachverhalt: 'sachverhalt',
      quelle: 'quelle',
      quelleText: 'quelleText',
      durchfuehrungId: 'durchfuehrungId',
      klasse: 'klasse',
      schwere: 'schwere',
      auswirkung: 'auswirkung',
      risikoIds: 'risiken',
    },
    parse: () => parseFormData(ErfassenFormular, formData, { repeatable: ['risiken'] }),
    aufruf: async (dienst, daten) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.feststellungErfassen, { body: daten });
      return {
        meldung: r.auswirkungHerabgestuft
          ? `Feststellung ${r.nummer} erfasst. Die steuerliche Auswirkung „nein“ stufen nur Berufsträger:innen ein; sie ist als „unklar“ zur Würdigung erfasst.`
          : `Feststellung ${r.nummer} erfasst.`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Status weiterschalten
// ---------------------------------------------------------------------------

const WeiterFormular = z.object({ von: FeststellungStatusSchema });

export async function feststellungWeiterAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    parse: () => parseFormData(WeiterFormular, formData),
    aufruf: async (dienst, daten): Promise<Ausgang> => {
      try {
        const { daten: r } = await dienst.rufe(ENDPUNKTE.feststellungWeiterschalten, {
          params: { feststellungId: objekt(feststellungId) },
          body: { von: daten.von },
        });
        return { meldung: `Status: ${FESTSTELLUNG_STATUS_LABEL[r.status]}.` };
      } catch (fehler) {
        // TCMS s7: gesperrter Schritt auf dem gesehenen Stand = 400 mit
        // Feldfehler `von` (fester Text der kanzleikonsole am Schritt);
        // 409 nur noch bei gleichzeitiger Änderung.
        if (fehler instanceof TcmsUngueltig && !fehler.lokal) {
          const text = weiterGesperrtText(fehler.felder);
          if (text !== null) {
            return {
              ok: false,
              error: text,
              errorCode: 'VALIDATION_ERROR',
              fieldErrors: { von: [text] },
            };
          }
        }
        if (fehler instanceof TcmsKonflikt) {
          return { ok: false, error: WEITER_KONFLIKT, errorCode: 'CONFLICT' };
        }
        throw fehler;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// §-153-Würdigung
// ---------------------------------------------------------------------------

const P153Formular = z.object({
  // Keine Vorauswahl: ohne gewählte Option kein Dienstaufruf.
  entscheidung: z.unknown().transform((wert, ctx) => {
    const geprueft = P153EntscheidungSchema.safeParse(wert);
    if (geprueft.success) return geprueft.data;
    ctx.addIssue({ code: 'custom', message: 'Bitte eine der vier Optionen wählen.' });
    return z.NEVER;
  }),
  begruendung: freitext(30, 4000),
  frist: z.preprocess(leerAlsUndefined, TagSchema.optional()),
  bisher: z.preprocess(leerAlsNull, P153EntscheidungSchema.nullable()),
});

export async function p153EntscheidenAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'WUERDIGEN',
    felder: { entscheidung: 'entscheidung', begruendung: 'begruendung', frist: 'frist' },
    parse: () => parseFormData(P153Formular, formData, { absentAsNull: true }),
    aufruf: async (dienst, daten) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.p153Entscheiden, {
        params: { feststellungId: objekt(feststellungId) },
        body: {
          entscheidung: daten.entscheidung,
          begruendung: daten.begruendung,
          ...(daten.frist ? { frist: daten.frist } : {}),
          bisher: daten.bisher,
        },
      });
      return {
        meldung: `Entscheidung dokumentiert: ${P153_LABEL[r.entscheidung].replace(' bis …', '')}${r.wiedervorlageNr ? ` · Wiedervorlage #${r.wiedervorlageNr}` : ''}.`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Würdigungsangaben, Erklärungen
// ---------------------------------------------------------------------------

const WuerdigungFormular = z.object({
  schwere: SchwereSchema,
  auswirkung: AuswirkungSchema,
  ursache: z.preprocess(leerAlsNull, freitext(0, 2000).nullable()),
});

export async function wuerdigungAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { schwere: 'schwere', auswirkung: 'auswirkung', ursache: 'ursache' },
    parse: () => parseFormData(WuerdigungFormular, formData, { absentAsNull: true }),
    aufruf: async (dienst, daten) => {
      await dienst.rufe(ENDPUNKTE.wuerdigungAktualisieren, {
        params: { feststellungId: objekt(feststellungId) },
        body: daten,
      });
      return { meldung: 'Würdigungsangaben gespeichert.' };
    },
  });
}

const ErklaerungFormular = z.object({
  // Bezeichnungen, einzeilig wie im Vertrag (TCMS s10): Zeilenumbruch und
  // unzulässige Zeichen als Feldfehler mit dem Text des Vertrags.
  steuerart: ErklaerungBodySchema.shape.steuerart,
  land: ErklaerungBodySchema.shape.land,
  zeitraum: ErklaerungBodySchema.shape.zeitraum,
  auswirkungEur: z.string().transform((roh, ctx) => {
    const wert = parseDezimal(roh);
    if (wert === 'fehler') {
      ctx.addIssue({ code: 'custom', message: 'Die geschätzte Auswirkung ist keine Zahl.' });
      return z.NEVER;
    }
    return wert;
  }),
});

export async function erklaerungAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: {
      steuerart: 'steuerart',
      land: 'land',
      zeitraum: 'zeitraum',
      auswirkungEur: 'auswirkungEur',
    },
    parse: () => parseFormData(ErklaerungFormular, formData),
    aufruf: async (dienst, daten) => {
      await dienst.rufe(ENDPUNKTE.erklaerungHinzufuegen, {
        params: { feststellungId: objekt(feststellungId) },
        body: daten,
      });
      return { meldung: 'Betroffene Erklärung erfasst.' };
    },
  });
}

// ---------------------------------------------------------------------------
// Maßnahmen
// ---------------------------------------------------------------------------

const MassnahmeFormular = z.object({
  beschreibung: freitext(5, 500),
  verantwortlich: z.string().transform((wert, ctx) => {
    const person = personAusWert(wert);
    if (!person) {
      ctx.addIssue({ code: 'custom', message: 'Bitte eine verantwortliche Person wählen.' });
      return z.NEVER;
    }
    return person;
  }),
  frist: TagSchema,
});

export async function massnahmeAnlegenAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { beschreibung: 'beschreibung', verantwortlich: 'verantwortlich', frist: 'frist' },
    parse: () => parseFormData(MassnahmeFormular, formData),
    vorbereiten: async (tx, k, daten) => {
      // Personen nur aus der kanzleikonsole: Kanzleiperson mit Mandantenzugriff
      // bzw. aktiver Kontakt genau dieses Mandanten.
      const bezug = { tenantId: k.g.tenantId, mandantId };
      const [person] =
        daten.verantwortlich.art === 'KANZLEI'
          ? await kanzleiPersonenFuerMandantTx(tx, bezug, [daten.verantwortlich.id], {
              feld: 'verantwortlich',
            })
          : await mandantKontakteTx(tx, bezug, [daten.verantwortlich.id], {
              feld: 'verantwortlich',
            });
      return { id: person!.id, art: daten.verantwortlich.art };
    },
    aufruf: async (dienst, daten, verantwortlich) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.massnahmeAnlegen, {
        params: { feststellungId: objekt(feststellungId) },
        body: { beschreibung: daten.beschreibung, verantwortlich, frist: daten.frist },
      });
      return { meldung: `Maßnahme angelegt · Wiedervorlage #${r.wiedervorlageNr}.` };
    },
  });
}

const ErledigenFormular = z.object({ nachweis: freitext(10, 2000) });

export async function massnahmeErledigenAction(
  mandantId: string,
  massnahmeId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'STANDARD',
    felder: { nachweis: 'nachweis' },
    parse: () => parseFormData(ErledigenFormular, formData),
    aufruf: async (dienst, daten) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.massnahmeErledigen, {
        params: { massnahmeId: objekt(massnahmeId, 'Maßnahme nicht gefunden.') },
        body: { nachweis: daten.nachweis },
      });
      return { meldung: `Maßnahme #${r.wiedervorlageNr} erledigt.` };
    },
  });
}

const NachkontrolleFormular = z.object({ kontrolleId: ObjektIdSchema, faelligAm: TagSchema });

export async function nachkontrolleAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { kontrolleId: 'kontrolleId', faelligAm: 'faelligAm' },
    parse: () => parseFormData(NachkontrolleFormular, formData),
    aufruf: async (dienst, daten) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.nachkontrolleAnlegen, {
        params: { feststellungId: objekt(feststellungId) },
        body: daten,
      });
      return { meldung: `Nachkontrolle ${r.kontrolleCode} angelegt und verknüpft.` };
    },
  });
}

// ---------------------------------------------------------------------------
// Verwerfen (Vier-Augen) und Vertraulichkeit
// ---------------------------------------------------------------------------

const VerwerfenFormular = z.object({ begruendung: freitext(30, 2000) });

export async function verwerfenBeantragenAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { begruendung: 'begruendung' },
    parse: () => parseFormData(VerwerfenFormular, formData),
    aufruf: async (dienst, daten) => {
      await dienst.rufe(ENDPUNKTE.feststellungVerwerfenBeantragen, {
        params: { feststellungId: objekt(feststellungId) },
        body: { begruendung: daten.begruendung },
      });
      return { meldung: 'Verwerfen beantragt. Eine zweite Person muss bestätigen.' };
    },
  });
}

export async function verwerfenBestaetigenAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  _formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'VERWERFEN_BESTAETIGEN',
    aufruf: async (dienst) => {
      await dienst.rufe(ENDPUNKTE.feststellungVerwerfenBestaetigen, {
        params: { feststellungId: objekt(feststellungId) },
      });
      return { meldung: 'Feststellung verworfen.' };
    },
  });
}

export async function verwerfenAblehnenAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  _formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    aufruf: async (dienst) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.feststellungVerwerfenAblehnen, {
        params: { feststellungId: objekt(feststellungId) },
      });
      return {
        meldung: r.zurueckgezogen ? 'Antrag zurückgezogen.' : 'Antrag auf Verwerfen abgelehnt.',
      };
    },
  });
}

const VertraulichFormular = z.object({ vertraulich: z.enum(['0', '1']) });

export async function vertraulichAction(
  mandantId: string,
  feststellungId: string,
  _vorher: TcmsErgebnis | null,
  formData: FormData,
): Promise<TcmsErgebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    // Markieren verlangt im Dienst kannWuerdigen (Grund WUERDIGEN); VERTRAULICH
    // nennt er nur für Nicht-Beteiligte einer vertraulichen Feststellung.
    keinRecht: 'WUERDIGEN',
    parse: () => parseFormData(VertraulichFormular, formData),
    aufruf: async (dienst, daten) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.feststellungVertraulichSetzen, {
        params: { feststellungId: objekt(feststellungId) },
        body: { vertraulich: daten.vertraulich === '1' },
      });
      return {
        meldung: !r.geaendert
          ? r.vertraulich
            ? 'Bereits vertraulich.'
            : 'Bereits nicht vertraulich.'
          : r.vertraulich
            ? 'Als vertraulich markiert – nur für Beteiligte sichtbar.'
            : 'Vertraulichkeit aufgehoben.',
      };
    },
  });
}
