import 'server-only';

// =============================================================================
// Ereignismeldung aus dem Portal mit Anlagen (TCMS s7, Integration;
// TCMS-NACHWEIS-001). Das Tax-CMS speichert zu jeder Anlage nur einen Verweis
// (Dokument-ID, SHA-256); die kanzleikonsole bindet das Dokument deshalb wie
// einen Nachweis (`tcms_document_reference`, Bezug „Ereignis“), damit es nicht
// gelöscht oder durch eine neue Version ersetzt wird, solange die Meldung
// darauf verweist.
//
// Ablauf:
//   1. Ablegen und Binden je Datei in der Commit-Transaktion der Ablage
//      (`portalAnlageAblegen`). Scheitert eine Datei, hat die Meldung den
//      Dienst nie erreicht: bereits gebundene Anlagen dieses Vorgangs werden
//      freigegeben („nicht angehängt“); die Dokumente bleiben in der Ablage.
//   2. Melden (Dienstaufruf außerhalb jeder Transaktion).
//        angenommen        → Ereignis-ID an den Verknüpfungen setzen,
//        eindeutig abgelehnt (4xx, offener Breaker, Dienst aus)
//                          → freigeben („nicht angehängt“),
//        Ausgang offen (Zeitlimit, Transport, 5xx, Protokoll)
//                          → Verknüpfungen bleiben ohne Ereignis-ID bestehen
//                            (im Zweifel schützen).
//   Verwerfen eines Ereignisses (Kanzlei, Vier-Augen) gibt seine Anlagen nach
//   der bestätigten Antwort des Dienstes frei: `meldungsAnlagenNachVerwerfen`.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import {
  ENDPUNKTE,
  type EreignisErgebnis,
  type PortalMeldungErgebnis,
} from '@taxtronik/tcms-contract';
import { log } from '@/server/logger';
import type { TcmsAktionsEingabe, TcmsDienst } from '@/server/tcms/aktion';
import { eindeutigAbgelehnt } from '@/server/tcms/durchfuehrung/nachweis-aktion';
import {
  meldungsAnlagenFreigeben,
  meldungsAnlagenZuordnen,
  type MeldungsAnlageFreigabeGrund,
} from '@/server/tcms/durchfuehrung/verweis';
import {
  portalAnlageAblegen,
  type PortalAblageKontext,
  type TcmsAnlageVerweis,
} from '@/server/tcms/portal/anlagen';

type MeldungBody = NonNullable<TcmsAktionsEingabe<typeof ENDPUNKTE.portalMeldungErfassen>['body']>;

/** Abgelegte und gebundene Anlagen eines Meldevorgangs. */
export interface MeldungsAnlagen {
  anlagen: TcmsAnlageVerweis[];
  verknuepfungen: string[];
}

async function freigeben(
  ctx: TenantContext,
  ziel: Parameters<typeof meldungsAnlagenFreigeben>[1],
  grund: MeldungsAnlageFreigabeGrund,
): Promise<void> {
  await meldungsAnlagenFreigeben(ctx, ziel, grund).catch((fehler: unknown) =>
    log.error(
      { component: 'tcms-meldung', err: (fehler as Error)?.name ?? 'unbekannt' },
      'tcms-meldung: Anlagen nicht freigegeben (Sperre bleibt)',
    ),
  );
}

/**
 * Legt die Dateien nacheinander ab und bindet sie (je Datei eine
 * Commit-Transaktion). Scheitert eine, werden die bereits gebundenen dieses
 * Vorgangs freigegeben und der Fehler weitergereicht.
 */
export async function meldungsAnlagenAblegen(
  ablage: PortalAblageKontext,
  dateien: readonly File[],
): Promise<MeldungsAnlagen> {
  const ergebnis: MeldungsAnlagen = { anlagen: [], verknuepfungen: [] };
  try {
    for (const datei of dateien) {
      const { verweis, verknuepfungId } = await portalAnlageAblegen(ablage, datei);
      ergebnis.anlagen.push(verweis);
      ergebnis.verknuepfungen.push(verknuepfungId);
    }
  } catch (fehler) {
    // Die Meldung hat den Dienst nie erreicht.
    await freigeben(ablage.ctx, { verknuepfungIds: ergebnis.verknuepfungen }, 'NOT_ATTACHED');
    throw fehler;
  }
  return ergebnis;
}

/**
 * Meldet das Ereignis und führt die Verknüpfungen der Anlagen nach (Ablauf im
 * Kopf der Datei). Wirft den Fehler des Dienstes weiter.
 */
export async function meldungErfassenUndBinden(
  dienst: TcmsDienst,
  ctx: TenantContext,
  body: MeldungBody,
  verknuepfungen: readonly string[],
): Promise<PortalMeldungErgebnis> {
  let ergebnis: PortalMeldungErgebnis;
  try {
    ({ daten: ergebnis } = await dienst.rufe(ENDPUNKTE.portalMeldungErfassen, { body }));
  } catch (fehler) {
    if (eindeutigAbgelehnt(fehler)) {
      await freigeben(ctx, { verknuepfungIds: verknuepfungen }, 'NOT_ATTACHED');
    }
    throw fehler;
  }
  const zugeordnet = await meldungsAnlagenZuordnen(ctx, verknuepfungen, ergebnis.id).catch(
    () => -1,
  );
  if (zugeordnet !== verknuepfungen.length) {
    // Die Sperre bleibt bestehen (offene Verknüpfung ohne Ereignis-ID).
    log.error(
      { component: 'tcms-meldung', anlagen: verknuepfungen.length, zugeordnet },
      'tcms-meldung: Ereignis-ID nicht an allen Anlagen gesetzt',
    );
  }
  return ergebnis;
}

/**
 * Nach dem Verwerfen eines Ereignisses (Bestätigung, Vier-Augen): Anlagen
 * freigeben, wenn die Antwort des Dienstes eindeutig ist – dasselbe Ereignis,
 * Status „verworfen“. Sonst bleibt die Sperre. Wirft nie.
 */
export async function meldungsAnlagenNachVerwerfen(
  ctx: TenantContext,
  ziel: { mandantId: string; ereignisId: string },
  antwort: EreignisErgebnis,
): Promise<void> {
  if (antwort.id !== ziel.ereignisId || antwort.status !== 'VERWORFEN') {
    log.warn(
      { component: 'tcms-meldung', status: antwort.status },
      'tcms-meldung: Verwerfen ohne eindeutige Antwort, Anlagen bleiben gebunden',
    );
    return;
  }
  await freigeben(ctx, ziel, 'DISCARDED');
}
