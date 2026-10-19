// =============================================================================
// @taxtronik/tcms-client — signierter Transport zum Tax-CMS (TCMS Stufe 2).
//
// Reiner Transport ohne Geschäftslogik und ohne DB-Zugriff. Wer handelt und
// welche Mandantenbezüge bestätigt werden, entscheidet die Web-App
// (apps/web/src/server/tcms) aus der serverseitig geprüften Sitzung.
// =============================================================================

export {
  TcmsClient,
  TcmsHealthSchema,
  NUR_SYSTEMAKTEUR,
  PERSONEN_AKTEURE,
  STANDARD_MAX_ANTWORT_BYTES,
  type FetchImpl,
  type TcmsAkteurAngaben,
  type TcmsAufruf,
  type TcmsClientOptionen,
  type TcmsEndpunkt,
  type TcmsHealth,
  type TcmsMethode,
} from './client';
export type { TcmsErgebnis } from './antwort';
export { rufeEndpunkt, type TcmsEndpunktEingabe } from './endpunkt';
export {
  holeOffeneNachrichten,
  meldeNachrichtZugestellt,
  MAX_NACHRICHTEN_JE_ABRUF,
  type OffeneNachricht,
} from './nachrichten';
export {
  TcmsFehler,
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
  type TcmsAusfallGrund,
  type TcmsFehlerDetails,
  type TcmsProtokollGrund,
} from './fehler';
export { baueZiel, kodiereQueryKomponente, type TcmsQuery, type Ziel } from './ziel';
export { istTcmsAktiv } from './gate';
