// =============================================================================
// Zeichenregeln der Eingaben (AGENTS.md „Betrieb und Lieferkette“): die eine
// Regel für einzeilige Texte und Dateinamen (`UNZULAESSIGE_ZEICHEN`,
// `DATEINAME_UNZULAESSIG`) und die Basisregel der Freitexte (`TEXT_UNZULAESSIG`).
//
// Eigenes Modul ohne weitere Abhängigkeiten, damit auch die Akteursbestätigung
// (`akteur.ts`, Claim `nam`) dieselbe Regel nutzt, ohne einen Importzyklus mit
// `bereiche/lesepfade.ts` (das die Akteursarten braucht). `bereiche/lesepfade.ts`
// exportiert alles hier unverändert weiter; Vertrag, Dienst und Demo
// importieren wie bisher über `@tcms/contract`.
// =============================================================================

import { z } from 'zod';

/**
 * Zeichenregel: Zeichen, die in einzeiligen Texten (Stammdaten, Titel, Namen,
 * Akteursname der Bestätigung) und Dateinamen nie vorkommen dürfen – eine
 * Regel für den ganzen Vertrag, den Dienst (`einzeilig`, Dateinamen von
 * Anlagen und Nachweisen, `pruefeVerweis`, `normalisiereAkteur`) und den
 * statischen Repo-Test (`repo-zeichen.test.ts`, dort ohne TAB und LF). Sie
 * folgt aus Unicode-Eigenschaften statt aus einer Liste (RT4-T-01): Eine Liste
 * übersah standardmäßig unsichtbare Zeichen wie die Variantenselektoren
 * U+FE00–U+FE0F und U+E0100–U+E01EF, mit denen sich beliebige Bytes in einem
 * sichtbaren Text verstecken lassen.
 *
 *   Cc   Steuerzeichen: C0 U+0000–U+001F (auch TAB, LF, CR), DEL, C1
 *   Cf   Formatzeichen: Richtung (LRM, RLM, ALM, Einbettung, Überschreibung,
 *        Isolierung), Nullbreite (ZWSP, ZWNJ, ZWJ, Wortverbinder, BOM),
 *        weiches Trennzeichen, Tag-Zeichen U+E0001–U+E007F u. a.
 *   Zl   Zeilentrenner U+2028; Zp Absatztrenner U+2029
 *   Default_Ignorable_Code_Point
 *        alles standardmäßig Unsichtbare, auch ohne Formatkategorie: Füller
 *        (U+115F, U+1160, U+3164, U+FFA0), Variantenselektoren, U+034F,
 *        U+17B4/U+17B5, U+180B–U+180F, reservierte Bereiche (U+2065,
 *        U+FFF0–U+FFF8, U+E0000–U+E0FFF)
 *   Cs   einzelne Surrogate (kein gültiger Text; PostgreSQL speichert sie nicht)
 *   Co   Privatnutzung (U+E000–U+F8FF, Ebenen 15 und 16): ohne vereinbarte
 *        Schrift unlesbar oder leer
 *   Noncharacter_Code_Point
 *        Nichtzeichen (U+FDD0–U+FDEF, U+xxFFFE/U+xxFFFF): nie Text
 *
 * Der Umfang folgt der Unicode-Version der Laufzeit (Node 24: Unicode 17);
 * Vertrag und kanzleikonsole laufen auf derselben Node-Version. Der Ausdruck
 * arbeitet auf Code Points (`u`) und steht ohne rohe Zeichen im Quelltext.
 */
export const UNZULAESSIG_KLASSE = String.raw`\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cs}\p{Co}\p{Noncharacter_Code_Point}`;
export const UNZULAESSIGE_ZEICHEN = new RegExp(`[${UNZULAESSIG_KLASSE}]`, 'u');

/**
 * Zeichen ohne sichtbaren Beitrag, nur für die Zählung sichtbarer Zeichen
 * (`sichtbareLaenge`): standardmäßig Unsichtbares und Formatzeichen (wie in der
 * Zeichenregel) sowie die zwei Platzhalter, die gerendert leer bzw. als bloßer
 * Kasten erscheinen: U+2800 (Braille-Leerzeichen, Kategorie So) und U+FFFC
 * (Objektersatzzeichen, So). Keine Zeichenregel – diese Zeichen bleiben in
 * Texten erlaubt, zählen aber nicht zur Mindestlänge.
 */
const OHNE_SICHTBAREN_BEITRAG = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}\u2800\ufffc]/gu;
const LEERRAUM_FOLGE = /\p{White_Space}+/gu;

/**
 * Zahl der sichtbaren Zeichen (Code Points) eines Texts: ohne unsichtbare
 * Zeichen und Platzhalter, Leerraumfolgen zählen als ein Zeichen, Leerraum am
 * Rand gar nicht. Damit erfüllt „a“ + 28 × ZWSP + „b“ oder 30 × U+2800 keine
 * Mindestlänge von 30 Zeichen (Begründungen, AGENTS.md Regel 2 und 4).
 */
export function sichtbareLaenge(s: string): number {
  const rest = s.replace(OHNE_SICHTBAREN_BEITRAG, '').replace(LEERRAUM_FOLGE, ' ').trim();
  let n = 0;
  for (const _ of rest) n += 1;
  return n;
}

/**
 * Mindestlänge in sichtbaren Zeichen (nur bei Mindestlänge ab 1; ein
 * optionaler Text darf leer bleiben). Greift erst, wenn die Längenprüfung von
 * zod bestanden ist, sonst stünde dieselbe Ursache doppelt in den Meldungen.
 */
function sichtbarGenug(t: string, min: number): boolean {
  if (min <= 0) return true;
  let codePoints = 0;
  for (const _ of t) codePoints += 1;
  if (codePoints < min) return true;
  return sichtbareLaenge(t) >= min;
}

const meldungSichtbar = (min: number) =>
  min > 1 ? `Mindestens ${min} sichtbare Zeichen` : 'Mindestens ein sichtbares Zeichen';

/**
 * Kombinierende Zeichen ohne Grundzeichen am Anfang oder mehr als vier
 * hintereinander („Zalgo“, Anzeige über die Zeile hinaus). Übliche Schriften
 * (Vietnamesisch, Devanagari, Thai) kommen mit höchstens drei aus.
 */
const ZEICHENSTAPEL = /^\p{M}|\p{M}{5}/u;

/**
 * Basisregel jedes Texts einer Eingabe:
 *
 *   - kein NUL und keine einzelnen Surrogate (RT4-T-08). PostgreSQL speichert
 *     beides nicht (TEXT kein NUL, JSONB weder `\u0000` noch ein einzelnes
 *     Surrogat); ohne die Regel endete eine vertragsgültige Eingabe als
 *     `500 INTERN`.
 *   - keine Steuerzeichen außer TAB, LF und CR: C0, DEL und C1 (U+0080–U+009F,
 *     etwa NEL und CSI) sind in Freitexten nie fachlich und wirken in Export,
 *     Terminal und CSV als Steuerbefehle.
 *   - keine expliziten Richtungssteuerzeichen (tcms-s9): Einbettung und
 *     Überschreibung U+202A–U+202E (LRE, RLE, PDF, LRO, RLO), Isolierung
 *     U+2066–U+2069 (LRI, RLI, FSI, PDI). Mit ihnen zeigt ein Text etwas
 *     anderes an, als er enthält („Trojan Source“) – in Feststellungen,
 *     Begründungen und Sachverhalten, also Inhalten mit Beweiswert.
 *   - keine Zeichen, die Text verstecken oder anders umbrechen, als er
 *     erscheint: Zeilen- und Absatztrenner U+2028/U+2029 (je nach Anzeige
 *     Umbruch oder nichts), die veralteten Formatzeichen U+206A–U+206F, BOM
 *     U+FEFF im Text, Interlinear-Anmerkungen U+FFF9–U+FFFB und Tag-Zeichen
 *     U+E0000–U+E007F (unsichtbare ASCII-Kopie, „Tag-Schmuggel“) – außer in
 *     einer Emoji-Flagge mit Tag-Folge (`FLAGGE_MIT_TAGS`, z. B. Schottland).
 *
 * Gilt für jeden Freitext (`mitTextBasis`, `freitext`). Zeilenumbruch, TAB,
 * Nullbreitenzeichen (ZWSP, ZWNJ, ZWJ) und Variantenselektoren bleiben in
 * mehrzeiligen Texten erlaubt (Emoji-Sequenzen, Thai, eingefügte Texte); die
 * impliziten Richtungsmarken (LRM, RLM, ALM) ebenso, sie ordnen keinen
 * Textabschnitt um. Mindestlängen zählen sichtbare Zeichen
 * (`sichtbareLaenge`). Einzeilige Texte und Dateinamen prüfen die strengere
 * Zeichenregel, die alles hier einschließt. Antworten mit gespeicherten Texten
 * prüfen nur die Länge (Altbestand bleibt lesbar).
 * `__tests__/eingabetexte.test.ts` prüft jedes Zeichenkettenfeld des
 * Endpunktregisters, `richtungszeichen.test.ts` den Umfang je Code Point.
 */
export const TEXT_UNZULAESSIG =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cs}\u202a-\u202e\u2066-\u2069\u2028\u2029\u206a-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;
export const TEXT_UNZULAESSIG_MELDUNG = 'Unzulässige Zeichen (NUL oder einzelnes Surrogat)';
/** NUL und einzelne Surrogate: nur für die Wahl der Meldung (die Regel ist `TEXT_UNZULAESSIG`). */
const NUL_ODER_SURROGAT = /[\u0000\p{Cs}]/u;
/** Übrige Steuerzeichen: nur für die Wahl der Meldung. */
const STEUERZEICHEN = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Emoji-Flagge mit Tag-Folge (Unicode TR 51: U+1F3F4, Tag-Kleinbuchstaben
 * oder -Ziffern, Tag-Ende U+E007F), etwa England, Schottland, Wales. Nur in
 * dieser Form sind Tag-Zeichen in Freitexten erlaubt.
 */
const FLAGGE_MIT_TAGS = /\u{1f3f4}[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]{1,6}\u{e007f}/gu;

/** Verletzt `t` die Basisregel? (Tag-Zeichen nur außerhalb einer Flagge.) */
export function verletztTextBasis(t: string): boolean {
  return TEXT_UNZULAESSIG.test(t.replace(FLAGGE_MIT_TAGS, ''));
}

/**
 * Hängt die Basisregel an eine Zeichenkette der Eingabe an, dazu die
 * Mindestlänge in sichtbaren Zeichen (die Mindestlänge von `s`). Meldungen:
 * NUL und Surrogate `TEXT_UNZULAESSIG_MELDUNG`, übrige Steuerzeichen
 * „Steuerzeichen sind nicht erlaubt“, alles andere „Unzulässige Zeichen“
 * (dieselbe Meldung wie bei einzeiligen Texten).
 */
export function mitTextBasis(s: z.ZodString): z.ZodString {
  const min = s.minLength ?? 0;
  return s
    .refine((t) => !verletztTextBasis(t), {
      error: (iss) =>
        typeof iss.input !== 'string'
          ? 'Unzulässige Zeichen'
          : NUL_ODER_SURROGAT.test(iss.input)
            ? TEXT_UNZULAESSIG_MELDUNG
            : STEUERZEICHEN.test(iss.input)
              ? 'Steuerzeichen sind nicht erlaubt'
              : 'Unzulässige Zeichen',
    })
    .refine((t) => sichtbarGenug(t, min), meldungSichtbar(min));
}

/** Freitext (mehrzeilig): getrimmt, Längengrenzen, mit Basisregel (ohne Steuerzeichen). */
export function freitext(min: number, max: number) {
  return mitTextBasis(z.string().trim().min(min).max(max));
}

/** Dateiname: dieselben Zeichen und zusätzlich keine Pfadtrenner (`/`, Backslash). */
export const DATEINAME_UNZULAESSIG = new RegExp(`[${UNZULAESSIG_KLASSE}/\\\\]`, 'u');

/** Höchstlänge eines Dateinamens in UTF-16-Einheiten (wie NTFS und die Ablage des Dienstes). */
export const DATEINAME_MAX = 255;

/**
 * Gültiger Dateiname einer Eingabe – eine Regel für Nachweise
 * (`gueltigerNachweisDateiname`), Ereignis-Anlagen (`AnlageVerweisSchema`)
 * und die Ablage des Dienstes (`pruefeVerweis`):
 *
 *   - 1 bis 255 UTF-16-Einheiten (überall dieselbe Zählung);
 *   - die Zeichenregel und keine Pfadtrenner (`DATEINAME_UNZULAESSIG`);
 *   - kein Leerraum am Anfang oder Ende, kein Punkt am Ende (damit auch keine
 *     reinen Punktfolgen wie `.`, `..`, `...`);
 *   - keine Folge von mehr als drei Leerraumzeichen (die Endung ließe sich
 *     sonst aus dem sichtbaren Bereich schieben, etwa `rechnung.pdf` +
 *     Geviert-Leerzeichen + `.exe`);
 *   - kein Zeichenstapel (`ZEICHENSTAPEL`) und mindestens ein sichtbares Zeichen.
 *
 * Der Name ist nur Anzeige (das Tax-CMS legt nichts unter ihm ab); Regeln
 * einzelner Dateisysteme (reservierte Gerätenamen unter Windows, `:`) prüft,
 * wer eine Datei unter diesem Namen anlegt.
 */
export function gueltigerDateiname(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= DATEINAME_MAX &&
    !DATEINAME_UNZULAESSIG.test(name) &&
    name === name.trim() &&
    !name.endsWith('.') &&
    !/\p{White_Space}{4}/u.test(name) &&
    !ZEICHENSTAPEL.test(name) &&
    sichtbareLaenge(name) > 0
  );
}

/**
 * Gespeicherte Dateinamen in Antworten (Ereignis-Anlagen aus dem Meldungs-Audit,
 * das hash-verkettet ist und nie umgeschrieben wird): nur die Zeichen, die schon
 * die frühere Eingaberegel abwies – C0, DEL, Pfadtrenner, Einbettung/
 * Überschreibung, Isolierung. Vor der Angleichung gespeicherte Namen (etwa mit
 * LRM oder Nullbreitenzeichen) bleiben so lesbar, wie eingefrorene Snapshots
 * (ADR 0001 §7); jede neue Eingabe prüft `gueltigerDateiname`.
 */
export const DATEINAME_GESPEICHERT_UNZULAESSIG = new RegExp(
  String.raw`[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]`,
  'u',
);

/**
 * Einzeiliger Text einer Eingabe: getrimmt, Längengrenzen und die
 * Zeichenregel – also auch ohne CR, LF und TAB (Header-Injektion in Betreffs,
 * Anzeige-Spoofing) –, ohne Zeichenstapel und mit der Mindestlänge in
 * sichtbaren Zeichen (kein leer wirkender Titel aus U+2800). Gilt für die
 * Stammdaten des Ankers, für alle Titel und Namen (RT4-T-03), auch in den
 * Vorlagendaten der Nachrichten (`nachrichtTitel`) und den Namen eingefrorener
 * Beschreibungen (`namensEintrag`), und für den Akteursnamen der Bestätigung
 * (`nam`). Antworten mit gespeicherten Texten prüfen weiter nur die Länge,
 * damit Altbestände lesbar bleiben (wie `DATEINAME_GESPEICHERT_UNZULAESSIG`).
 */
export function einzeilig(min: number, max: number, meldungMin?: string) {
  return z
    .string()
    .trim()
    .min(min, meldungMin)
    .max(max)
    .refine((s) => !UNZULAESSIGE_ZEICHEN.test(s) && !ZEICHENSTAPEL.test(s), 'Unzulässige Zeichen')
    .refine((s) => sichtbarGenug(s, min), meldungMin ?? meldungSichtbar(min));
}
