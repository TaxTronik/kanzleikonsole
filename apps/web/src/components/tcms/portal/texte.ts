// =============================================================================
// Feste Texte des Tax-CMS im Mandantenportal (TCMS Stufe 3, Bereich D; aus der
// Demo portal/tcms/aufgaben/[id]/page.tsx, server/freigaben-daten.ts und
// components/durchfuehrung/formulare.tsx). Sie-Form, ohne interne Begriffe.
// Texte entstehen aus strukturierten Feldern der Antwort (Status, Codezustand),
// nie aus Fehlermeldungen des Dienstes.
// =============================================================================

import type { AnzeigeStatus } from '@taxtronik/tcms-domain';
import { isoDatumText } from '../format';
import { fmtGroesse } from '../durchfuehrung/werte';

/** Dateiauswahl im Portal (Positivliste PORTAL_ANLAGE_MIME des Vertrags). */
export const PORTAL_ANLAGE_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.txt,.xlsx,.xls,.docx,.doc,.zip';

/** Hinweis zur Dateiauswahl aus den Grenzen (Vertrag und Body-Limit der Server-Actions). */
export function portalAnlageHinweis(g: {
  maxDateien: number;
  maxBytes: number;
  maxGesamt: number;
}): string {
  return `höchstens ${g.maxDateien} Dateien, je bis ${fmtGroesse(g.maxBytes)}, zusammen bis ${fmtGroesse(g.maxGesamt)} (PDF, Bild, CSV, Text, Excel, Word, ZIP)`;
}

/** Status einer Kontrollaufgabe in Portal-Sprache (Anzeige aus `anzeige` des Dienstes). */
export function aufgabeStatusText(a: {
  anzeige: AnzeigeStatus;
  faelligAm: string;
  periodeBis: string;
  bestaetigungOffen: boolean;
}): string {
  switch (a.anzeige) {
    case 'UEBERFAELLIG':
      return `überfällig (Frist ${isoDatumText(a.faelligAm)})`;
    case 'FAELLIG':
      return `fällig bis ${isoDatumText(a.faelligAm)}`;
    case 'IN_DURCHFUEHRUNG':
      return `in Bearbeitung · Frist ${isoDatumText(a.faelligAm)}`;
    case 'ZURUECKGEWIESEN':
      return 'zur Überarbeitung zurückgegeben';
    case 'ZUR_GEGENZEICHNUNG':
      return a.bestaetigungOffen
        ? 'übermittelt – Bestätigung ausstehend'
        : 'übermittelt – Prüfung durch die Kanzlei';
    case 'OHNE_BEFUND':
      return 'abgeschlossen – ohne Befund';
    case 'MIT_BEFUND':
      return 'abgeschlossen – mit Befund';
    case 'ENTFALLEN':
      return 'entfallen';
    default:
      return `geplant (ab ${isoDatumText(a.periodeBis)})`;
  }
}

export const FREIGABE_ART_LABEL: Readonly<Record<string, string>> = {
  ZIELE: 'Compliance-Ziele · Freigabe',
  BESCHREIBUNG: 'CMS-Beschreibung · Freigabe',
  RISIKOAKZEPTANZ: 'Risikoakzeptanz · Freigabe',
  AUFKLAERUNG: 'Risikoaufklärung · Bestätigung',
  KENNTNISNAHME: 'Kenntnisnahme',
};

export function freigabeArtLabel(art: string): string {
  return Object.hasOwn(FREIGABE_ART_LABEL, art) ? FREIGABE_ART_LABEL[art]! : art;
}

/**
 * 409 auf „Code anfordern“ ohne Grund (Rückfall): Seit TCMS s10 trägt jedes
 * 409 dieses Endpunkts einen Grund (`fehler.konflikt`), dessen fester Text
 * gilt (TCMS_KONFLIKT_TEXTE in server/tcms/zustand.ts); ein 409 ohne Grund
 * weist schon der Client als Vertragsverletzung ab. Der Text des Dienstes
 * erreicht die Oberfläche nie.
 */
export const CODE_ANFORDERN_KONFLIKT =
  'Gerade kann kein neuer Code angefordert werden – etwa weil Sie in der letzten Stunde schon mehrere Codes angefordert haben. Bitte verwenden Sie den zuletzt gesendeten Code oder versuchen Sie es später erneut; nach dem Neuladen zeigt die Seite den aktuellen Stand.';

/**
 * 409 auf „Freigeben“ ohne Grund (Rückfall, wie oben): Code abgelaufen (auch
 * nach einem Wechsel des Code-Schlüssels im Tax-CMS), gesperrt oder
 * Anforderung erledigt. Mit Grund gilt der feste Text je Grund.
 */
export const CODE_NICHT_MEHR_GUELTIG =
  'Dieser Code kann nicht mehr verwendet werden – er ist abgelaufen oder die Anforderung hat sich geändert. Bitte laden Sie die Seite neu und fordern Sie einen neuen Code an.';

/**
 * Hinweis zum Codezustand `ABGELAUFEN`: mit Datum nur, wenn der Ablauf
 * erreicht ist; meldet der Dienst einen Code vor seinem Ablauf als
 * abgelaufen (Wechsel des Code-Schlüssels), ohne Datum.
 */
export function codeAbgelaufenText(
  ablauf: string | null,
  datumText: (iso: string) => string,
  jetzt: number = Date.now(),
): string {
  const zeit = ablauf ? Date.parse(ablauf) : Number.NaN;
  return ablauf && Number.isFinite(zeit) && zeit <= jetzt
    ? `Der Code ist am ${datumText(ablauf)} abgelaufen. Bitte fordern Sie einen neuen an.`
    : 'Der Code ist nicht mehr gültig. Bitte fordern Sie einen neuen an.';
}

/**
 * Ohne Leserecht im Portal (`rechte.portalLesen` der Übersicht) liefert das
 * Tax-CMS nur die eigenen Meldungen (TCMS s8).
 */
export const NUR_EIGENE_MELDUNGEN =
  'Sie sehen nur Meldungen, die Sie selbst abgegeben haben. Alle Meldungen Ihres Unternehmens sehen die gesetzliche Vertretung und die Tax-Compliance-Beauftragten.';

/** Ergebnis eines falschen Codes (strukturierte Antwort des Dienstes → fester Text). */
export function codeFehlerText(grund: 'CODE_FALSCH' | 'GESPERRT', verbleibend: number): string {
  if (grund === 'GESPERRT' || verbleibend <= 0) {
    return 'Der Bestätigungscode ist nach mehreren Fehlversuchen gesperrt. Bitte wenden Sie sich an Ihre Kanzlei.';
  }
  return `Der Code stimmt nicht. Noch ${verbleibend} ${verbleibend === 1 ? 'Versuch' : 'Versuche'}.`;
}

// ---------------------------------------------------------------------------
// Ereignismeldung mit offenem Ausgang (kk-tcms-s10nach, TCMS s10)
// ---------------------------------------------------------------------------

/**
 * Erstes Absenden ohne verlässliche Antwort: Die Meldung hat einen
 * Idempotenzschlüssel; erneutes Absenden desselben Formulars, das nächste
 * Öffnen der Seite und „Jetzt erneut übermitteln“ wiederholen sie mit
 * demselben Schlüssel – es entsteht keine doppelte Meldung.
 */
export const MELDUNG_AUSGANG_OFFEN =
  'Ihre Meldung konnte nicht sicher übermittelt werden – das Tax-CMS hat nicht rechtzeitig geantwortet. Sie können erneut auf „Ereignis melden“ klicken: Die Meldung wird mit denselben Angaben wiederholt (Änderungen im Formular werden dabei nicht übernommen), eine doppelte Meldung entsteht nicht. Andernfalls wiederholt TaxTronik die Übermittlung beim nächsten Öffnen dieser Seite.';

/** Ein anderer Versuch desselben Absendens läuft gerade. */
export const MELDUNG_LAEUFT =
  'Diese Meldung wird gerade übermittelt. Bitte laden Sie die Seite in einigen Minuten neu und prüfen Sie Ihre bisherigen Meldungen.';

/** Das Formular ist älter als das Wiederholungsfenster (neuer Schlüssel nötig). */
export const MELDUNG_ABGELAUFEN =
  'Diese Meldung kann nicht mehr wiederholt werden. Bitte laden Sie die Seite neu und prüfen Sie unter „Ihre bisherigen Meldungen“, ob sie eingegangen ist.';

/** Ergebnis einer Klärung offener Meldungen (Zahlen aus der kanzleikonsole, keine Inhalte). */
export function meldungKlaerungText(k: {
  angenommen: readonly string[];
  aufgeloest: number;
  offen: number;
  ungeklaert: number;
}): string {
  const teile: string[] = [];
  if (k.angenommen.length) {
    teile.push(
      k.angenommen.length === 1
        ? `Ihre Meldung ist eingegangen (Vorgangsnummer ${k.angenommen[0]}).`
        : `Ihre Meldungen sind eingegangen (Vorgangsnummern ${k.angenommen.join(', ')}).`,
    );
  }
  if (k.aufgeloest) {
    teile.push(
      'Eine Meldung wurde nie übermittelt; ihre Anlagen liegen in Ihren Dokumenten. Bitte melden Sie das Ereignis erneut.',
    );
  }
  if (k.offen) {
    teile.push(
      'Das Tax-CMS ist gerade nicht erreichbar; die Übermittlung wird beim nächsten Öffnen dieser Seite wiederholt.',
    );
  }
  if (k.ungeklaert) {
    teile.push(
      'Eine Meldung lässt sich nicht automatisch zuordnen; Ihre Kanzlei klärt sie. Bitte melden Sie das Ereignis nicht erneut.',
    );
  }
  return teile.join(' ') || 'Keine Meldung wartet auf Übermittlung.';
}
