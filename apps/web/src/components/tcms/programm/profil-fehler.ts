// =============================================================================
// Verständliche Feldfehler des Geschäftsprofils (TCMS s8, Altbestand).
//
// Gespeicherte Profile liest der Vertrag tolerant
// (`ProfilAntwortenGespeichertSchema`: Bezeichnungen nur mit Längengrenze);
// gespeichert wird ein Profil aber nur nach der Regel für Eingaben
// (`ProfilAntwortenSchema`: Bezeichnungen einzeilig, ohne unsichtbare
// Zeichen). Ein Stand aus der Zeit davor scheitert deshalb beim erneuten
// Speichern an Feldern, die der Mensch nicht sieht (Zeilenumbruch im
// Shopsystem, Steuerzeichen in einer Warengruppe …). Diese Datei übersetzt
// den Pfad einer Prüfmeldung (`p4.warengruppen.2.name`, in der Einrichtung mit
// Präfix `profil.`) in die Bezeichnung des Formulars („P4 Sortiment und
// Steuersätze · Warengruppe 3“). Bezeichnungen der Fragen aus der Domain,
// Feldnamen wie im Formular (components/tcms/programm/profil-formular.tsx).
// =============================================================================

import { PROFIL_FRAGEN } from '@taxtronik/tcms-domain';

/** Feldbezeichnungen je Frage; `#` steht für die laufende Nummer eines Listeneintrags. */
const FELDER: Readonly<Record<string, string>> = {
  'p1.shopSystem': 'Shopsystem',
  'p1.marktplaetze.#': 'Marktplatz #',
  'p1.eigenerShop': 'Eigener Shop',
  'p2.lager.#.land': 'Lager #: Land',
  'p2.lager.#.seit': 'Lager #: Beginn',
  'p2.lager.#.art': 'Lager #: Art',
  'p3.laender.#': 'Zielland #',
  'p3.b2bAnteilProzent': 'B2B-Anteil in Prozent',
  'p4.warengruppen.#.name': 'Warengruppe #',
  'p5.laender.#': 'Herkunftsland #',
  'p5.zollabwicklung': 'Zollabwicklung',
  'p6.zahlungswege.#': 'Zahlungsweg #',
  'p8.systeme.#.art': 'System #: Art',
  'p8.systeme.#.name': 'System #: Name',
  'p8.systeme.#.version': 'System #: Version',
  'p9.ossSeit': 'OSS-Registrierung seit',
  'p9.lokaleUstNr.#': 'Registrierungsland #',
  'p10.vorjahresumsatzEur': 'Vorjahresumsatz',
  'p10.euFernverkaeufeVorjahrEur': 'EU-Fernverkäufe Vorjahr',
  'p10.euFernverkaeufeLfdEur': 'EU-Fernverkäufe laufendes Jahr',
  'p11.anbieter.#': 'Anbieter #',
};

/**
 * Bezeichnung eines Prüfpfads im Geschäftsprofil („P1 Verkaufskanäle ·
 * Shopsystem“) oder `null`, wenn der Pfad keine Profilfrage nennt.
 */
export function profilFeldBezeichnung(pfad: string): string | null {
  const teile = pfad.split('.');
  if (teile[0] === 'profil') teile.shift();
  const frage = PROFIL_FRAGEN.find((f) => f.key === teile[0]);
  if (!frage) return null;
  const kopf = `${frage.nr} ${frage.titel}`;
  const nummern = teile.filter((t) => /^\d+$/.test(t)).map((t) => Number(t) + 1);
  const muster = teile.map((t) => (/^\d+$/.test(t) ? '#' : t)).join('.');
  const feld = Object.hasOwn(FELDER, muster) ? FELDER[muster]! : null;
  if (feld === null) return kopf;
  let i = 0;
  return `${kopf} · ${feld.replace(/#/g, () => String(nummern[i++] ?? ''))}`;
}

/** Meldung für Fehler, die keine Profilfrage nennen (Aufbau, unbekannte Felder). */
export const PROFIL_FEHLER_ALLGEMEIN = 'Bitte prüfen Sie die Angaben des Profils.';

/**
 * Feldfehler der Prüfung als lesbare Zeilen „<Bezeichnung>: <Meldung>“.
 * `feldbezogen`: mindestens eine Meldung nennt eine Profilfrage; Fehler ohne
 * Profilfrage ergeben einmal die allgemeine Meldung.
 */
export function profilFehlerZeilen(
  fieldErrors: Readonly<Record<string, readonly string[] | undefined>>,
): { zeilen: string[]; feldbezogen: boolean } {
  const zeilen = new Set<string>();
  let feldbezogen = false;
  for (const [pfad, meldungen] of Object.entries(fieldErrors)) {
    const ort = profilFeldBezeichnung(pfad);
    if (ort) feldbezogen = true;
    for (const m of meldungen ?? []) zeilen.add(ort ? `${ort}: ${m}` : PROFIL_FEHLER_ALLGEMEIN);
  }
  if (zeilen.size === 0) zeilen.add(PROFIL_FEHLER_ALLGEMEIN);
  return { zeilen: [...zeilen], feldbezogen };
}

/** Gesamtmeldung, wenn ein (älterer) Profilstand so nicht gespeichert werden kann. */
export const PROFIL_ALTBESTAND_HINWEIS =
  'Einige Angaben des Profils können so nicht gespeichert werden – oft Zeilenumbrüche oder unsichtbare Zeichen aus einem älteren Stand oder aus kopierten Texten. Bitte korrigieren Sie die genannten Felder (Text neu eintippen) und speichern Sie erneut.';
