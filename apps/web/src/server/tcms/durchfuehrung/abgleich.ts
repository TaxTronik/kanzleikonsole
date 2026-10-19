// =============================================================================
// Abgleich offener Nachweis-Verknüpfungen (TCMS s7, Bereich C;
// TCMS-NACHWEIS-001).
//
// Eine Verknüpfung (`tcms_document_reference`) entsteht VOR dem Anhängen im
// Tax-CMS und sperrt das Dokument. Bleibt der Ausgang des Anhängens offen
// (Zeitlimit, Transport, Protokollfehler), bleibt sie ohne Nachweis-ID offen –
// im Zweifel geschützt. Seit TCMS s7 sagt `nachweiseJeDokumentLesen`, welche
// Nachweise des Mandanten ein Dokument führen (auch entfernte). Damit klärt
// die kanzleikonsole solche Verknüpfungen:
//
//   - führt der Dienst einen aktiven Nachweis dieser Durchführung zu dem
//     Dokument, der noch an keiner anderen offenen Verknüpfung hängt
//     → bestätigen (Nachweis-ID setzen; Sperre bleibt),
//   - führt er ihn nur als entfernt → freigeben („REMOVED“),
//   - führt er für diese Durchführung keinen (oder nur bereits gebundene)
//     → freigeben („NOT_ATTACHED“).
//
// Nur nach einer eindeutigen, gegen den Vertrag geprüften Antwort; jeder
// Fehler beim Lesen (Transport, Zeitlimit, 5xx, 401/403, 404) lässt die
// Verknüpfung unverändert – ein späteres Öffnen versucht es erneut.
//
// Wann: beim Öffnen der Kontrolldurchführung durch eine Kanzleiperson (Seite
// /staff/clients/:id/tcms/durchfuehrungen/:did), nicht als Worker-Job. Der
// Lesepfad ist nur für Kanzleipersonen mit Leserecht am Mandanten freigegeben
// (`akteure: KANZLEI`); der Zustell-Worker bestätigt ausschließlich den
// Systemakteur und darf keine Person bestätigen (TCMS-AKTEUR-001,
// MAIL-OUTBOX-001). Ein Job bräuchte eine erfundene Kanzleiperson oder einen
// System-Endpunkt im Tax-CMS (Vorschlag). Geklärt wird je Aufruf höchstens
// ABGLEICH_MAX_JE_AUFRUF Verknüpfungen, die älter als ABGLEICH_MIN_ALTER_MS
// sind – so trifft der Abgleich kein Anhängen, das gerade noch läuft
// (Zeitlimit des Clients 10 s).
// =============================================================================

import type { TenantContext, TxClient } from '@taxtronik/db';
import { ENDPUNKTE, type NachweiseJeDokument } from '@taxtronik/tcms-contract';
import { log } from '@/server/logger';
import { tcmsLesenOptional, tcmsTenantLesen, type TcmsMandantSeite } from '@/server/tcms/seite';
import {
  nachweisVerknuepfungBestaetigen,
  nachweisVerknuepfungFreigeben,
  type NachweisFreigabeGrund,
} from './verweis';

/** Mindestalter einer offenen Verknüpfung vor dem Abgleich (weit über dem Zeitlimit). */
export const ABGLEICH_MIN_ALTER_MS = 5 * 60_000;
/** Höchstens so viele Verknüpfungen je Öffnen der Seite (begrenzt die Dienstaufrufe). */
export const ABGLEICH_MAX_JE_AUFRUF = 10;

const OBJEKT_ID = /^[a-z0-9]{1,64}$/;

export interface OffeneVerknuepfung {
  id: string;
  documentId: string;
  tcmsExecutionId: string;
}

export type AbgleichEntscheidung =
  | { art: 'BESTAETIGEN'; nachweisId: string }
  | { art: 'FREIGEBEN'; grund: NachweisFreigabeGrund };

/**
 * Entscheidung für eine offene Verknüpfung aus der geprüften Antwort des
 * Dienstes zu ihrem Dokument (rein). `gebunden`: Nachweis-IDs, die bereits an
 * einer offenen Verknüpfung hängen (höchstens eine je Nachweis).
 */
export function abgleichEntscheidung(
  v: OffeneVerknuepfung,
  antwort: NachweiseJeDokument,
  gebunden: ReadonlySet<string>,
): AbgleichEntscheidung | null {
  if (antwort.dokumentId.toLowerCase() !== v.documentId.toLowerCase()) return null;
  const dieser = antwort.nachweise.filter((n) => n.durchfuehrungId === v.tcmsExecutionId);
  const frei = dieser
    .filter((n) => !n.entfernt && !gebunden.has(n.id) && OBJEKT_ID.test(n.id))
    .map((n) => n.id)
    .sort();
  if (frei.length > 0) return { art: 'BESTAETIGEN', nachweisId: frei[0]! };
  if (dieser.some((n) => n.entfernt)) return { art: 'FREIGEBEN', grund: 'REMOVED' };
  return { art: 'FREIGEBEN', grund: 'NOT_ATTACHED' };
}

/** Offene Verknüpfungen ohne Nachweis-ID dieser Durchführung, älter als `bis`. */
export async function offeneVerknuepfungenTx(
  tx: TxClient,
  bezug: { tenantId: string; mandantId: string },
  durchfuehrungId: string,
  bis: Date,
): Promise<{ offen: OffeneVerknuepfung[]; gebunden: Set<string> }> {
  const offen = await tx.tcmsDocumentReference.findMany({
    where: {
      tenantId: bezug.tenantId,
      clientId: bezug.mandantId,
      tcmsExecutionId: durchfuehrungId,
      releasedAt: null,
      tcmsEvidenceId: null,
      createdAt: { lt: bis },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: ABGLEICH_MAX_JE_AUFRUF,
    select: { id: true, documentId: true, tcmsExecutionId: true },
  });
  const dokumente = [...new Set(offen.map((v) => v.documentId))];
  const belegt =
    dokumente.length === 0
      ? []
      : await tx.tcmsDocumentReference.findMany({
          where: {
            tenantId: bezug.tenantId,
            clientId: bezug.mandantId,
            documentId: { in: dokumente },
            releasedAt: null,
            tcmsEvidenceId: { not: null },
          },
          select: { tcmsEvidenceId: true },
        });
  return {
    offen,
    gebunden: new Set(belegt.flatMap((b) => (b.tcmsEvidenceId ? [b.tcmsEvidenceId] : []))),
  };
}

export interface AbgleichErgebnis {
  bestaetigt: number;
  freigegeben: number;
  /** Ohne eindeutige Antwort unverändert (nächstes Öffnen versucht es erneut). */
  offen: number;
}

/**
 * Klärt offene Verknüpfungen der Durchführung (Ablauf im Kopf der Datei).
 * Wirft nie: Ein Fehler lässt die Verknüpfungen unverändert und erscheint nur
 * im Protokoll (ohne IDs und Inhalte).
 */
export async function offeneNachweiseAbgleichen(
  seite: TcmsMandantSeite,
  durchfuehrungId: string,
  jetzt: Date = new Date(),
): Promise<AbgleichErgebnis> {
  const ergebnis: AbgleichErgebnis = { bestaetigt: 0, freigegeben: 0, offen: 0 };
  try {
    const tenantId = seite.session.user.tenantId;
    const { offen, gebunden } = await tcmsTenantLesen(seite, (tx) =>
      offeneVerknuepfungenTx(
        tx,
        { tenantId, mandantId: seite.mandantId },
        durchfuehrungId,
        new Date(jetzt.getTime() - ABGLEICH_MIN_ALTER_MS),
      ),
    );
    if (offen.length === 0) return ergebnis;
    const ctx: TenantContext = {
      tenantId,
      actorId: seite.session.user.staffId,
      actorType: 'STAFF',
    };
    const antworten = new Map<string, NachweiseJeDokument | null>();
    for (const v of offen) {
      if (!antworten.has(v.documentId)) {
        const r = await tcmsLesenOptional(seite, ENDPUNKTE.nachweiseJeDokumentLesen, {
          query: { dokumentId: v.documentId },
        });
        antworten.set(v.documentId, r.ok ? r.daten : null);
      }
      const antwort = antworten.get(v.documentId) ?? null;
      const e = antwort ? abgleichEntscheidung(v, antwort, gebunden) : null;
      if (e === null) {
        ergebnis.offen += 1;
      } else if (e.art === 'BESTAETIGEN') {
        if (await nachweisVerknuepfungBestaetigen(ctx, v.id, e.nachweisId)) {
          gebunden.add(e.nachweisId);
          ergebnis.bestaetigt += 1;
        } else ergebnis.offen += 1;
      } else {
        const n = await nachweisVerknuepfungFreigeben(ctx, { verknuepfungId: v.id }, e.grund);
        if (n === 1) ergebnis.freigegeben += 1;
        else ergebnis.offen += 1;
      }
    }
    if (ergebnis.bestaetigt + ergebnis.freigegeben + ergebnis.offen > 0) {
      log.info(
        { component: 'tcms-nachweis-abgleich', ...ergebnis },
        'Nachweis-Verknüpfungen abgeglichen',
      );
    }
  } catch (fehler) {
    log.warn(
      {
        component: 'tcms-nachweis-abgleich',
        fehler: fehler instanceof Error ? fehler.name : 'unbekannt',
      },
      'Abgleich der Nachweis-Verknüpfungen nicht möglich',
    );
  }
  return ergebnis;
}
