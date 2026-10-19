// =============================================================================
// Postausgang des Tax-CMS für den Zustell-Worker (TCMS Stufe 4).
//
// Ein Client je Prozess, gebaut mit `NUR_SYSTEMAKTEUR`: Er bestätigt
// ausschließlich den Systemakteur und erreicht über das Endpunktregister nur
// die drei Nachrichten-Endpunkte (Abruf, „zugestellt“, „unzustellbar“; der
// Client prüft `akteure`; der Dienst antwortet auf alles andere 404). Konfiguration wie in der Web-App aus
// getTcmsConfig() (`null` bei TCMS_DEPLOYMENT=disabled).
// =============================================================================

import { getTcmsConfig } from '@taxtronik/config/env-schema';
import {
  holeOffeneNachrichten,
  meldeNachrichtUnzustellbar,
  meldeNachrichtZugestellt,
  NUR_SYSTEMAKTEUR,
  TcmsClient,
  type NachrichtUnzustellbarGrund,
  type OffeneNachricht,
  type TcmsAkteurAngaben,
} from '@taxtronik/tcms-client';

/** Die drei Aufrufe des Zustelljobs (für Tests austauschbar). */
export interface TcmsPostausgang {
  holen(akteur: TcmsAkteurAngaben, limit: number): Promise<OffeneNachricht[]>;
  /** Wirft TcmsNichtGefunden bei 404 (unbekannt oder fremd = erledigt). */
  melden(akteur: TcmsAkteurAngaben, nachrichtId: string): Promise<void>;
  /**
   * Meldet „unzustellbar“ mit festem Grund (TCMS s6). Wirft TcmsNichtGefunden
   * (404) bzw. TcmsKonflikt (409: schon zugestellt oder mit anderem Grund
   * gemeldet) – für den Job beides erledigt.
   */
  unzustellbar(
    akteur: TcmsAkteurAngaben,
    nachrichtId: string,
    grund: NachrichtUnzustellbarGrund,
  ): Promise<void>;
}

/** Postausgang über einen Client, der nur den Systemakteur bestätigt. */
export function postausgangUeber(client: TcmsClient): TcmsPostausgang {
  return {
    holen: async (akteur, limit) =>
      (await holeOffeneNachrichten(client, { akteur, limit })).daten.nachrichten,
    melden: async (akteur, nachrichtId) => {
      await meldeNachrichtZugestellt(client, { akteur, nachrichtId });
    },
    unzustellbar: async (akteur, nachrichtId, grund) => {
      await meldeNachrichtUnzustellbar(client, { akteur, nachrichtId, grund });
    },
  };
}

let postausgang: TcmsPostausgang | null | undefined;

/** Postausgang des Prozesses oder `null`, wenn das Tax-CMS nicht konfiguriert ist. */
export function tcmsPostausgang(): TcmsPostausgang | null {
  if (postausgang === undefined) {
    const config = getTcmsConfig();
    postausgang = config
      ? postausgangUeber(new TcmsClient({ config, akteurArten: NUR_SYSTEMAKTEUR }))
      : null;
  }
  return postausgang;
}

/** Nur für Tests: Konfiguration beim nächsten Zugriff neu lesen. */
export function tcmsPostausgangZuruecksetzen(): void {
  postausgang = undefined;
}
