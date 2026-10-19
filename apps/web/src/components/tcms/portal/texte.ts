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

/** Ergebnis eines falschen Codes (strukturierte Antwort des Dienstes → fester Text). */
export function codeFehlerText(grund: 'CODE_FALSCH' | 'GESPERRT', verbleibend: number): string {
  if (grund === 'GESPERRT' || verbleibend <= 0) {
    return 'Der Bestätigungscode ist nach mehreren Fehlversuchen gesperrt. Bitte wenden Sie sich an Ihre Kanzlei.';
  }
  return `Der Code stimmt nicht. Noch ${verbleibend} ${verbleibend === 1 ? 'Versuch' : 'Versuche'}.`;
}
