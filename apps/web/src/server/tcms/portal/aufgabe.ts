// =============================================================================
// Kontrollaufgabe im Portal (TCMS Stufe 3, Bereich D): Body von
// `portalAufgabeSpeichern` aus dem Formular. Der Aufbau (Zahl der Schritte,
// Kennzahlen) kommt aus der Antwort des Dienstes (`portalAufgabeLesen`), nicht
// aus dem Formular; die Grenzen prüft der Vertrag beim Senden und der Dienst.
// Differenzkennzahlen haben keinen Wert (das Tax-CMS berechnet sie).
// Bewusst kein 'use server'-Modul: nie als Server Action aufrufbar.
// =============================================================================

import type { DurchfuehrungSpeichernBodySchema, Kontrollaufgabe } from '@taxtronik/tcms-contract';
import type { z } from 'zod';
import { parseDezimal } from '@/components/tcms/durchfuehrung/werte';
import type { ActionFailure } from '@/server/actions/action-runner';

/** Formularfelder `schritt_<i>_erledigt|kommentar`, `wert_<key>`, `bemerkung_<key>`, `erklaert_<key>`, `ergebnis`, `ergebnisKommentar`. */
export type AufgabeFormular = Readonly<Record<string, string | undefined>>;

export type SpeichernBody = z.input<typeof DurchfuehrungSpeichernBodySchema>;

export const BETRAG_FORMAT = 'Bitte einen Betrag im Format 1.234,56 angeben.';

export function koerperAusFormular(
  a: Pick<Kontrollaufgabe, 'schritte' | 'kontrolle'>,
  f: AufgabeFormular,
): { ok: true; body: SpeichernBody } | ActionFailure {
  const schritte = a.schritte.map((_, i) => ({
    erledigt: f[`schritt_${i}_erledigt`] === 'on',
    kommentar: (f[`schritt_${i}_kommentar`] ?? '').trim(),
  }));
  const fieldErrors: Record<string, string[]> = {};
  const werte: SpeichernBody['werte'] = [];
  for (const k of a.kontrolle.kennzahlen) {
    const bemerkung = (f[`bemerkung_${k.key}`] ?? '').trim();
    const erklaert = f[`erklaert_${k.key}`] === 'on';
    if (k.differenzAus) {
      werte.push({ key: k.key, wert: null, bemerkung, erklaert });
      continue;
    }
    const wert = parseDezimal(f[`wert_${k.key}`] ?? '');
    if (wert === 'fehler') fieldErrors[`wert_${k.key}`] = [BETRAG_FORMAT];
    else werte.push({ key: k.key, wert, bemerkung, erklaert });
  }
  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors,
    };
  }
  const ergebnis =
    f['ergebnis'] === 'OHNE_BEFUND' || f['ergebnis'] === 'MIT_BEFUND' ? f['ergebnis'] : null;
  const kommentar = (f['ergebnisKommentar'] ?? '').trim();
  return {
    ok: true,
    body: { schritte, werte, ergebnis, ergebnisKommentar: kommentar === '' ? null : kommentar },
  };
}
