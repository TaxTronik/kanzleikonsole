import 'server-only';

// =============================================================================
// Ereignismeldung aus dem Portal mit Anlagen (TCMS s7, Integration;
// TCMS-NACHWEIS-001; idempotent seit kk-tcms-s10nach, TCMS s10). Das Tax-CMS
// speichert zu jeder Anlage nur einen Verweis (Dokument-ID, SHA-256); die
// kanzleikonsole bindet das Dokument deshalb wie einen Nachweis
// (`tcms_document_reference`, Bezug „Ereignis“), damit es nicht gelöscht oder
// durch eine neue Version ersetzt wird, solange die Meldung darauf verweist.
//
// Ablauf eines Absendens (ein Idempotenzschlüssel, im Formular erzeugt;
// Meldevorgang und Entscheidung: ./meldevorgang.ts):
//   0. Vorgang beanspruchen: neu, oder Wiederholung desselben Absendens
//      (gleicher Schlüssel, gesendet, im Fenster) – dann ohne neue Ablage mit
//      dem gespeicherten Inhalt weiter bei 3.
//   1. Ablegen und Binden je Datei in der Commit-Transaktion der Ablage
//      (`portalAnlageAblegen`, mit Schlüssel). Scheitert eine Datei, hat die
//      Meldung den Dienst nie erreicht: bereits gebundene Anlagen dieses
//      Vorgangs werden freigegeben („nicht angehängt“), der Vorgang entfällt;
//      die Dokumente bleiben in der Ablage.
//   2. Sendezeitpunkt und verschlüsselten Inhalt am Vorgang festhalten.
//   3. Melden (Dienstaufruf außerhalb jeder Transaktion, mit Schlüssel).
//        angenommen        → Ereignis-ID an den Anlagen, Vorgang gelöscht;
//        eindeutig abgelehnt (nur erster Versuch: 4xx, offener Breaker,
//        Dienst aus)       → Anlagen frei („nicht angehängt“), Vorgang
//                            gelöscht;
//        IDEMPOTENZ_ABWEICHUNG → Vorgang gelöscht, Anlagen gebunden
//                            (ungeklärt);
//        Ausgang offen (Zeitlimit, Transport, 5xx, Protokoll; bei einer
//        Wiederholung auch jede Ablehnung)
//                          → Vorgang bleibt mit Inhalt; Wiederholung mit
//                            demselben Schlüssel (Formular, nächstes Öffnen,
//                            Knopf) innerhalb des Fensters.
//   Verwerfen eines Ereignisses (Kanzlei, Vier-Augen) gibt seine Anlagen nach
//   der bestätigten Antwort des Dienstes frei: `meldungsAnlagenNachVerwerfen`.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { ENDPUNKTE, type EreignisErgebnis } from '@taxtronik/tcms-contract';
import { log } from '@/server/logger';
import type { TcmsDienst } from '@/server/tcms/aktion';
import { eindeutigAbgelehnt } from '@/server/tcms/durchfuehrung/nachweis-aktion';
import {
  meldungsAnlagenFreigeben,
  type MeldungsAnlageFreigabeGrund,
} from '@/server/tcms/durchfuehrung/verweis';
import {
  istIdempotenzAbweichung,
  meldevorgangBeanspruchen,
  meldevorgangGesendet,
  meldevorgangWiederholen,
  meldungBody,
  nachfuehren,
  type Meldevorgang,
  type MeldevorgangBezug,
  type MeldungInhalt,
} from '@/server/tcms/portal/meldevorgang';
import {
  portalAnlageAblegen,
  type PortalAblageKontext,
  type TcmsAnlageVerweis,
} from '@/server/tcms/portal/anlagen';

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
 * Legt die Dateien nacheinander ab und bindet sie mit dem Schlüssel des
 * Vorgangs (je Datei eine Commit-Transaktion). Scheitert eine, werden die
 * bereits gebundenen dieses Vorgangs freigegeben und der Fehler weitergereicht.
 */
export async function meldungsAnlagenAblegen(
  ablage: PortalAblageKontext,
  dateien: readonly File[],
  schluessel: string | null = null,
): Promise<MeldungsAnlagen> {
  const ergebnis: MeldungsAnlagen = { anlagen: [], verknuepfungen: [] };
  try {
    for (const datei of dateien) {
      const { verweis, verknuepfungId } = await portalAnlageAblegen(ablage, datei, schluessel);
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

/** Eingaben eines Absendens (Mandant, Person und Ablage nur aus der Sitzung). */
export interface MeldungEingabe {
  schluessel: string;
  dateien: readonly File[];
  inhalt: Omit<MeldungInhalt, 'anlagen'>;
}

export type MeldungAusgang =
  | { art: 'angenommen'; nummer: string; wiederholung: boolean }
  /** Ausgang offen; der Vorgang wird mit demselben Schlüssel wiederholt. */
  | { art: 'offen' }
  /** Ein anderer Versuch desselben Absendens läuft (bzw. Inhalt gerade nicht lesbar). */
  | { art: 'laeuft' }
  /** Wiederholungsfenster abgelaufen: Formular neu laden (neuer Schlüssel). */
  | { art: 'abgelaufen' };

/** Erster Versuch: Ablehnung klärt (Anlagen frei); offener Ausgang hält den Vorgang. */
async function erstesSenden(
  dienst: TcmsDienst,
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  inhalt: MeldungInhalt,
): Promise<MeldungAusgang> {
  let r: { id: string; nummer: string };
  try {
    ({ daten: r } = await dienst.rufe(ENDPUNKTE.portalMeldungErfassen, {
      body: meldungBody(inhalt, vorgang.schluessel),
    }));
  } catch (fehler) {
    if (istIdempotenzAbweichung(fehler)) {
      await nachfuehren(ctx, b, vorgang, { art: 'ungeklaert' });
      throw fehler;
    }
    if (eindeutigAbgelehnt(fehler)) {
      await nachfuehren(ctx, b, vorgang, { art: 'abgelehnt' });
      throw fehler;
    }
    await nachfuehren(ctx, b, vorgang, { art: 'offen' });
    return offen(fehler);
  }
  await nachfuehren(ctx, b, vorgang, { art: 'angenommen', ereignisId: r.id });
  return { art: 'angenommen', nummer: r.nummer, wiederholung: false };
}

function offen(fehler: unknown): MeldungAusgang {
  log.warn(
    { component: 'tcms-meldung', fehler: (fehler as Error)?.name ?? 'unbekannt' },
    'tcms-meldung: Ausgang offen, Wiederholung mit demselben Schlüssel',
  );
  return { art: 'offen' };
}

/**
 * Meldet ein Ereignis mit Anlagen (Ablauf im Kopf der Datei). Wirft eine
 * eindeutige Ablehnung des Dienstes (und IDEMPOTENZ_ABWEICHUNG) weiter; ein
 * offener Ausgang ist ein Ergebnis.
 */
export async function meldungErfassen(
  dienst: TcmsDienst,
  ablage: PortalAblageKontext,
  e: MeldungEingabe,
): Promise<MeldungAusgang> {
  const ctx = ablage.ctx;
  const b: MeldevorgangBezug = {
    tenantId: ablage.tenantId,
    mandantId: ablage.clientId,
    kontaktId: ablage.contactId,
  };
  const vorgang = await meldevorgangBeanspruchen(ctx, b, e.schluessel);
  if (vorgang.art === 'laeuft' || vorgang.art === 'abgelaufen') return { art: vorgang.art };
  if (vorgang.art === 'wiederholung') {
    // Dasselbe Absenden noch einmal: gespeicherter Inhalt, keine neue Ablage.
    try {
      const r = await meldevorgangWiederholen(dienst, ctx, b, vorgang, vorgang.inhalt);
      return { art: 'angenommen', nummer: r.nummer, wiederholung: true };
    } catch (fehler) {
      if (istIdempotenzAbweichung(fehler)) throw fehler;
      return offen(fehler);
    }
  }
  let anlagen: TcmsAnlageVerweis[];
  try {
    ({ anlagen } = await meldungsAnlagenAblegen(ablage, e.dateien, vorgang.schluessel));
  } catch (fehler) {
    // Nie gesendet: Vorgang auflösen (gebundene Anlagen sind schon frei).
    await nachfuehren(ctx, b, vorgang, { art: 'abgelehnt' });
    throw fehler;
  }
  const inhalt: MeldungInhalt = { ...e.inhalt, anlagen };
  await meldevorgangGesendet(ctx, b, vorgang, inhalt);
  return erstesSenden(dienst, ctx, b, vorgang, inhalt);
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
