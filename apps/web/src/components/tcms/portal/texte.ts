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
 * 409 auf „Code anfordern“ (TCMS s8): u. a. höchstens einige Anforderungen je
 * Stunde und Freigabe; der Dienst nennt den Grund nur als Text, der die
 * Oberfläche nie erreicht. Ein fester Text für alle Fälle.
 */
export const CODE_ANFORDERN_KONFLIKT =
  'Gerade kann kein neuer Code angefordert werden – etwa weil Sie in der letzten Stunde schon mehrere Codes angefordert haben. Bitte verwenden Sie den zuletzt gesendeten Code oder versuchen Sie es später erneut; nach dem Neuladen zeigt die Seite den aktuellen Stand.';

/**
 * 409 auf „Freigeben“ (TCMS s8): Code abgelaufen (auch nach einem Wechsel des
 * Code-Schlüssels im Tax-CMS), gesperrt oder Anforderung erledigt.
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
