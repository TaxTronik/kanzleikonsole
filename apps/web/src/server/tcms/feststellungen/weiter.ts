// =============================================================================
// Gesperrter Schritt einer Feststellung (TCMS s7): Der Dienst antwortet auf
// `POST …/feststellungen/:id/weiter` mit `400 UNGUELTIG` und dem Grund als
// Feldfehler `von`, wenn der Schritt auf dem gesehenen Stand fachlich gesperrt
// ist (§-153-Würdigung offen, Maßnahme fehlt oder offen, Nachkontrolle fehlt,
// geschlossen bzw. verworfen); `409` bleibt der gleichzeitigen Änderung
// vorbehalten.
//
// Der Text des Dienstes erreicht die Oberfläche nie (Leitfaden Abschnitt 6).
// Angezeigt wird ein Text der kanzleikonsole, ausgewählt über eine feste
// Klassifikation: Nennt der Feldfehler einen der Sperrgründe der vendorten
// Domain (`naechsterFeststellungsschritt`, dieselben Texte, mit denen der
// Dienst begründet), erscheint „Noch nicht möglich: <Grund der Domain>.“, sonst
// ein fester Rückfall. Entschieden wird nichts: ob der Schritt geht, sagt
// allein die Antwort des Dienstes.
// =============================================================================

import {
  naechsterFeststellungsschritt,
  type Auswirkung,
  type FeststellungStatus,
} from '@taxtronik/tcms-domain';

/** Rückfall für einen gesperrten Schritt ohne bekannten Grund (z. B. geschlossen). */
export const WEITER_GESPERRT_RUECKFALL =
  'Dieser Schritt ist auf dem aktuellen Stand nicht möglich. Bitte prüfen Sie die Voraussetzungen unter „Nächster Schritt“ und laden Sie die Seite neu.';

/** 409: Der Status ist inzwischen ein anderer als der gesehene. */
export const WEITER_KONFLIKT =
  'Die Feststellung wurde zwischenzeitlich geändert. Bitte laden Sie die Seite neu.';

function grund(
  status: FeststellungStatus,
  auswirkung: Auswirkung,
  fakten: { p153?: boolean; massnahmen?: number; offen?: number },
): string | null {
  return naechsterFeststellungsschritt({
    status,
    auswirkung,
    p153Entschieden: fakten.p153 ?? true,
    massnahmen: fakten.massnahmen ?? 1,
    massnahmenOffen: fakten.offen ?? 0,
    nachkontrolleOhneBefund: false,
  }).blockiert;
}

/**
 * Sperrgründe der Domain, einmal beim Laden aufgezählt (je Status die
 * Bedingung, die den Schritt sperrt). Längere zuerst, damit kein Grund einen
 * anderen als Teilstring überdeckt.
 */
const SPERRGRUENDE: readonly string[] = [
  grund('IN_WUERDIGUNG', 'JA', { p153: false }),
  grund('IN_WUERDIGUNG', 'NEIN', { massnahmen: 0 }),
  grund('MASSNAHMEN_OFFEN', 'NEIN', { offen: 1 }),
  grund('NACHKONTROLLE', 'NEIN', {}),
]
  .filter((g): g is string => typeof g === 'string' && g.length > 0)
  .sort((a, b) => b.length - a.length);

/** Feldfehler `von` aus der Antwort (mit oder ohne Präfix `body.`), sonst null. */
function vonTexte(felder: Readonly<Record<string, readonly string[]>>): readonly string[] | null {
  for (const pfad of ['von', 'body.von']) {
    if (Object.hasOwn(felder, pfad)) {
      const texte = felder[pfad];
      if (Array.isArray(texte)) return texte;
    }
  }
  return null;
}

/**
 * Fester Text zu einem gesperrten Schritt oder `null`, wenn der 400 keinen
 * Feldfehler `von` trägt (dann gilt die gemeinsame Abbildung).
 */
export function weiterGesperrtText(
  felder: Readonly<Record<string, readonly string[]>>,
): string | null {
  const texte = vonTexte(felder);
  if (texte === null) return null;
  for (const g of SPERRGRUENDE) {
    if (texte.some((t) => typeof t === 'string' && t.includes(g)))
      return `Noch nicht möglich: ${g}.`;
  }
  return WEITER_GESPERRT_RUECKFALL;
}

/** Nur für Tests: die aufgezählten Sperrgründe. */
export const WEITER_SPERRGRUENDE_FUER_TESTS = SPERRGRUENDE;
