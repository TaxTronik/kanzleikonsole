// =============================================================================
// Zeichenregel der kanzleikonsole für Texte an das Tax-CMS (TCMS s8, RT4-T-01,
// RT4-T-03, RT4-T-08).
//
// Der Vertrag hat EINE Zeichenregel aus Unicode-Eigenschaften
// (`UNZULAESSIG_KLASSE`: Cc, Cf, Zl, Zp, Default_Ignorable_Code_Point, Cs). Sie
// gilt für einzeilige Texte (Titel, Namen, Funktion, Rechtsform …) und
// Dateinamen (dort zusätzlich `/` und `\`); Freitexte prüfen nur die
// Basisregel (`TEXT_UNZULAESSIG`: kein NUL, keine einzelnen Surrogate).
// Diese Datei übernimmt die Regel aus dem Vertrag (nie kopiert) und wendet sie
// auf zwei Arten an:
//
//   - Stammdaten der kanzleikonsole (Namen von Personen und Mandanten,
//     Rechtsform, Dateinamen hochgeladener Dateien): STILL bereinigen
//     (`tcmsTextBereinigen`). Zeilen- und Spaltentrenner werden zu
//     Leerzeichen, alle anderen unzulässigen Zeichen entfallen (unsichtbar,
//     z. B. Variantenselektor U+FE0F hinter einem Emoji), Leerraum wird
//     zusammengefasst, gekürzt wird ohne ein Ersatzpaar zu trennen.
//   - Eingaben, die der Mensch eintippt: NICHT still ändern, sondern als
//     Feldfehler mit dem Text des Vertrags abweisen – in den Formularschemas
//     mit den Schemas des Vertrags (`einzeilig`, `freitext`, `mitTextBasis`)
//     und, wo eine Eingabe erst im Body auffällt, über die lokale Prüfung des
//     Clients (`vertragsZeichenMeldung`, server/tcms/zustand.ts).
//
// Der Umfang folgt der Unicode-Version der Laufzeit (Node 24, Unicode 17);
// kanzleikonsole und Dienst laufen auf derselben Node-Hauptversion.
// =============================================================================

import {
  einzeilig,
  freitext,
  TEXT_UNZULAESSIG,
  TEXT_UNZULAESSIG_MELDUNG,
  UNZULAESSIG_KLASSE,
} from '@taxtronik/tcms-contract';

/** Alle Zeichen der Regel des Vertrags (global, für das Bereinigen). */
const UNZULAESSIG_ALLE = new RegExp(`[${UNZULAESSIG_KLASSE}]`, 'gu');
/** Basisregel der Freitexte (global). */
const TEXT_UNZULAESSIG_ALLE = new RegExp(TEXT_UNZULAESSIG.source, 'gu');
/** Zeilen- und Spaltentrenner: werden Leerzeichen statt zu verschwinden (Wortgrenze bleibt). */
const TRENNER = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
const PFADTRENNER = /[/\\]/gu;

export type TcmsTextArt = 'EINZEILIG' | 'DATEINAME' | 'FREITEXT';

/**
 * Kürzt auf höchstens `max` UTF-16-Codeeinheiten (wie `max` im Vertrag), ohne
 * ein Ersatzpaar zu trennen.
 */
export function tcmsKuerzen(text: string, max: number): string {
  if (text.length <= max) return text;
  let ergebnis = '';
  for (const zeichen of text) {
    if (ergebnis.length + zeichen.length > max) break;
    ergebnis += zeichen;
  }
  return ergebnis;
}

/**
 * Bereinigt einen Text aus der kanzleikonsole für ein Feld des Vertrags
 * (still; nur für Stammdaten, nie für Eingaben des Menschen).
 *
 * - `EINZEILIG`: ohne Zeichen der Regel, Trenner → Leerzeichen, Leerraum
 *   zusammengefasst und getrimmt.
 * - `DATEINAME`: wie `EINZEILIG`, zusätzlich `/` und `\` → `_`.
 * - `FREITEXT`: nur NUL und einzelne Surrogate entfallen; Zeilen bleiben.
 *
 * `max` kürzt danach (Codeeinheiten, ohne Ersatzpaare zu trennen). Das
 * Ergebnis kann leer sein; Pflichtfelder prüft der Aufrufer.
 */
export function tcmsTextBereinigen(roh: string, art: TcmsTextArt, max?: number): string {
  let text: string;
  if (art === 'FREITEXT') {
    text = roh.replace(TEXT_UNZULAESSIG_ALLE, '');
  } else {
    text = roh.replace(TRENNER, ' ').replace(UNZULAESSIG_ALLE, '');
    if (art === 'DATEINAME') text = text.replace(PFADTRENNER, '_');
    text = text.replace(/\s+/gu, ' ').trim();
  }
  return max === undefined ? text : tcmsKuerzen(text, max).trim();
}

/** Meldung des Vertrags zu einer Eingabe (aus dessen Schema, nicht kopiert). */
function meldungDesVertrags(schema: { safeParse(w: unknown): unknown }, probe: string): string {
  const ergebnis = schema.safeParse(probe) as {
    success: boolean;
    error?: { issues: { message: string }[] };
  };
  const meldung = ergebnis.success ? undefined : ergebnis.error?.issues[0]?.message;
  if (!meldung) throw new Error('tcms-zeichen: Meldung des Vertrags nicht ermittelbar');
  return meldung;
}

/**
 * Feste Meldungen des Vertrags zu unzulässigen Zeichen: einzeilig („Unzulässige
 * Zeichen“), Basisregel der Freitexte und Steuerzeichen in Freitexten. Einmal
 * aus den Schemas des Vertrags ermittelt; ändert sich der Text dort, folgt die
 * Anzeige.
 */
export const VERTRAG_ZEICHEN_MELDUNGEN: ReadonlySet<string> = new Set([
  meldungDesVertrags(einzeilig(0, 10), '\u200b'),
  meldungDesVertrags(freitext(0, 10), '\u0001'),
  TEXT_UNZULAESSIG_MELDUNG,
]);

/**
 * Meldung einer lokalen Prüfung (Schema des Vertrags im Client), wenn sie eine
 * der festen Zeichenmeldungen des Vertrags ist; sonst `null` (dann gilt der
 * allgemeine Feldtext). Texte des Dienstes laufen hier nie durch.
 */
export function vertragsZeichenMeldung(meldung: string): string | null {
  return VERTRAG_ZEICHEN_MELDUNGEN.has(meldung) ? meldung : null;
}

/**
 * Feldfehler der Basisregel für einen Freitext, den der Mensch eingetippt hat
 * (kein NUL, kein einzelnes Surrogat): der Text des Vertrags oder `null`. Für
 * Formulare, die ihren Body selbst zusammensetzen (Durchführung, Kontrollaufgabe).
 */
export function freitextZeichenFehler(wert: string): string | null {
  return TEXT_UNZULAESSIG.test(wert) ? TEXT_UNZULAESSIG_MELDUNG : null;
}
