// =============================================================================
// Formulare der Kontrolldurchführung → Body des Vertrags (TCMS Stufe 3,
// Bereich C; aus der Demo server/durchfuehrung-daten.ts `speichernAls`).
//
// Die Struktur (Anzahl Schritte, Kennzahlen) kommt aus der zuvor gelesenen
// Durchführung des Dienstes, nie aus dem Formular; das Formular liefert nur
// die Eingaben. Ob gespeichert bzw. eingereicht werden darf und ob die Angaben
// vollständig sind, prüft der Dienst.
// =============================================================================

import {
  DF_MAX_ERGEBNIS_KOMMENTAR,
  DF_MAX_SCHRITT_KOMMENTAR,
  DF_MAX_WERT_BEMERKUNG,
  GegenzeichnungFeststellungSchema,
  type DurchfuehrungDetail,
} from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import { parseDezimal } from '@/components/tcms/durchfuehrung/werte';
import { germanFieldError, validationFailure } from '@/server/actions/form-data';
import type { ActionResult } from '@/server/actions/types';

type Fehlschlag = ActionResult & { ok: false; error: string };

function text(formData: FormData, feld: string): string {
  const wert = formData.get(feld);
  return typeof wert === 'string' ? wert : '';
}

export interface SpeichernEingabe {
  schritte: { erledigt: boolean; kommentar: string }[];
  werte: { key: string; wert: number | null; bemerkung: string; erklaert: boolean }[];
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  ergebnisKommentar: string | null;
}

/**
 * Liest Schritte, Werte und Ergebnis aus dem Entwurfsformular. Unlesbare
 * Beträge ergeben Feldfehler (`wert_<key>`) ohne Dienstaufruf.
 */
export function speichernAusFormular(
  formData: FormData,
  d: Pick<DurchfuehrungDetail, 'schritte' | 'kontrolle'>,
): { ok: true; eingabe: SpeichernEingabe; einreichen: boolean } | Fehlschlag {
  const schritte = d.schritte.map((_, i) => ({
    erledigt: formData.get(`schritt_${i}_erledigt`) === 'on',
    kommentar: text(formData, `schritt_${i}_kommentar`).trim().slice(0, DF_MAX_SCHRITT_KOMMENTAR),
  }));
  const werte: SpeichernEingabe['werte'] = [];
  const unlesbar: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const k of d.kontrolle.kennzahlen) {
    const bemerkung = text(formData, `bemerkung_${k.key}`).trim().slice(0, DF_MAX_WERT_BEMERKUNG);
    const erklaert = formData.get(`erklaert_${k.key}`) === 'on';
    if (k.differenzAus) {
      werte.push({ key: k.key, wert: null, bemerkung, erklaert });
      continue;
    }
    const wert = parseDezimal(text(formData, `wert_${k.key}`));
    if (wert === 'fehler') {
      unlesbar.push(k.label);
      fieldErrors[`wert_${k.key}`] = ['Bitte einen Betrag im Format 1.234,56 eingeben.'];
    } else werte.push({ key: k.key, wert, bemerkung, erklaert });
  }
  if (unlesbar.length > 0) {
    return {
      ok: false,
      error: `Bitte Beträge im Format 1.234,56 eingeben: ${unlesbar.join(', ')}.`,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors,
    };
  }
  const e = text(formData, 'ergebnis');
  const ergebnis = e === 'OHNE_BEFUND' || e === 'MIT_BEFUND' ? e : null;
  const ergebnisKommentar =
    text(formData, 'ergebnisKommentar').trim().slice(0, DF_MAX_ERGEBNIS_KOMMENTAR) || null;
  return {
    ok: true,
    eingabe: { schritte, werte, ergebnis, ergebnisKommentar },
    einreichen: text(formData, 'absicht') === 'einreichen',
  };
}

/** Feldnamen der Inline-Feststellung beim Gegenzeichnen mit Befund. */
const BEFUND_FELD = {
  titel: 'fTitel',
  sachverhalt: 'fSachverhalt',
  klasse: 'fKlasse',
  schwere: 'fSchwere',
  auswirkung: 'fAuswirkung',
  risikoIds: 'fRisiko',
} as const;

export type BefundEingabe = z.output<typeof GegenzeichnungFeststellungSchema>;

/**
 * Inline-Feststellung beim Gegenzeichnen (nur wenn das Formular sie enthält).
 * Geprüft mit dem Schema des Vertrags; Fehler landen am Formularfeld.
 */
export function befundAusFormular(
  formData: FormData,
): { ok: true; feststellung: BefundEingabe | undefined } | Fehlschlag {
  if (!formData.has(BEFUND_FELD.titel)) return { ok: true, feststellung: undefined };
  const roh = {
    titel: text(formData, BEFUND_FELD.titel),
    sachverhalt: text(formData, BEFUND_FELD.sachverhalt),
    klasse: text(formData, BEFUND_FELD.klasse),
    schwere: text(formData, BEFUND_FELD.schwere),
    auswirkung: text(formData, BEFUND_FELD.auswirkung),
    risikoIds: [
      ...new Set(
        formData.getAll(BEFUND_FELD.risikoIds).filter((v): v is string => typeof v === 'string'),
      ),
    ],
  };
  const geprueft = GegenzeichnungFeststellungSchema.safeParse(roh, { error: germanFieldError });
  if (!geprueft.success) {
    return validationFailure(
      geprueft.error.issues.map((i) => ({
        path: [BEFUND_FELD[String(i.path[0]) as keyof typeof BEFUND_FELD] ?? '_form'],
        message: i.message,
      })),
    );
  }
  return { ok: true, feststellung: geprueft.data };
}
