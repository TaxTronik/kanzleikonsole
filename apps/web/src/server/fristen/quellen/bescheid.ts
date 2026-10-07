// Fachkatalog: TAX-CONTROL-STATUS-001 — gemeinsame Teile der drei Bescheidquellen
// (Einspruchsfrist, Klagefrist, interner Prüftermin).

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { NOTICE_KIND_LABELS } from '@/lib/domain-labels';
import { begruendungTragfaehig } from '../eintrag';

const KONTROLLBUCH_NOTICE_KIND_LABELS: Readonly<Record<string, string>> = {
  ...NOTICE_KIND_LABELS,
  USTA: 'USt-VA',
  UST_JAHR: 'USt-Jahr',
  EST: 'ESt',
  KST: 'KSt',
  GEWST_MESSBESCHEID: 'GewSt-Mess',
  GEWST: 'GewSt',
  LSTA: 'LSt-Anm.',
  FESTSTELLUNG: 'Feststellung',
  ZERLEGUNG: 'Zerlegung',
  SONSTIGE: 'Bescheid',
};

export function bescheidTitel(kind: string, period: string): string {
  return `${KONTROLLBUCH_NOTICE_KIND_LABELS[kind] ?? kind} ${period}`;
}

/**
 * Ergebnis der Vorabfrage einer Bescheidquelle: Zeilen, die ein Prisma-Filter
 * nicht einordnen kann. `verspaetet`: Einlegung nach dem Fristende (entscheidet
 * `toEintrag`). `ohneBegruendung`: Bestandskraft mit einer Begründung ohne zehn
 * sichtbare Zeichen (Altbestand vor der DB-Prüfung); die Disposition fehlt.
 */
export interface BescheidVorab {
  verspaetet: string[];
  ohneBegruendung: string[];
}

/**
 * Bestandskraft-Disposition fehlt: Status oder einer der drei Nachweise fehlt,
 * oder die Begründung ist nicht tragfähig (siehe `begruendungTragfaehig`).
 */
export function dispositionFehlt(ohneBegruendung: readonly string[]): Prisma.TaxNoticeWhereInput {
  return {
    OR: [
      { status: { not: 'BESTANDSKRAEFTIG' } },
      { legalFinalAt: null },
      { legalFinalBy: null },
      { legalFinalReason: null },
      ...(ohneBegruendung.length ? [{ id: { in: [...ohneBegruendung] } }] : []),
    ],
  };
}

/** Vollständig dokumentierte Bestandskraft-Disposition (Rückschau-Zweig). */
export function dispositionVorhanden(
  ohneBegruendung: readonly string[],
): Prisma.TaxNoticeWhereInput {
  return {
    status: 'BESTANDSKRAEFTIG',
    legalFinalAt: { not: null },
    legalFinalBy: { not: null },
    legalFinalReason: { not: null },
    ...(ohneBegruendung.length ? { id: { notIn: [...ohneBegruendung] } } : {}),
  };
}

/** Ergebnis der Einlegungs-/Dispositionsprüfung einer Einspruchs- oder Klagefrist. */
export interface Einlegungsergebnis {
  filingTimely: boolean;
  filingLate: boolean;
  disposition: boolean;
}

/** Disposition schließt nur, wenn nicht fristgerecht eingelegt wurde (wie bisher). */
export function dispositionDokumentiert(
  filingTimely: boolean,
  n: {
    status: string;
    legalFinalAt: Date | null;
    legalFinalBy: string | null;
    legalFinalReason: string | null;
  },
): boolean {
  return (
    !filingTimely &&
    n.status === 'BESTANDSKRAEFTIG' &&
    Boolean(n.legalFinalAt && n.legalFinalBy) &&
    begruendungTragfaehig(n.legalFinalReason)
  );
}

export function kontrollzustand(
  erledigt: boolean,
  disposition: boolean,
): 'OPEN' | 'CLOSED_FULFILLED' | 'CLOSED_DISPOSITION' {
  if (disposition) return 'CLOSED_DISPOSITION';
  return erledigt ? 'CLOSED_FULFILLED' : 'OPEN';
}

/** Wer/wann geschlossen hat: fristgerechte Einlegung, sonst dokumentierte Disposition. */
export function abschluss(
  ergebnis: Einlegungsergebnis,
  filed: { at: Date | null; by: string | null },
  final: { at: Date | null; by: string | null },
  name: (staffId: string | null) => string | null,
): { erledigtAm: Date | null; erledigtVon: string | null } {
  if (ergebnis.filingTimely) return { erledigtAm: filed.at, erledigtVon: name(filed.by) };
  if (ergebnis.disposition) return { erledigtAm: final.at, erledigtVon: name(final.by) };
  return { erledigtAm: null, erledigtVon: null };
}

interface VorabZeile {
  id: string;
  verspaetet: boolean;
  ohneBegruendung: boolean;
}

function vorabListen(rows: VorabZeile[]): BescheidVorab {
  return {
    verspaetet: rows.filter((row) => row.verspaetet).map((row) => row.id),
    ohneBegruendung: rows.filter((row) => row.ohneBegruendung).map((row) => row.id),
  };
}

/**
 * Vorabfrage der Einspruchsfristen. Prisma kann zwei Spalten in einem normalen
 * Where-Objekt nicht portabel vergleichen und keine Begründung auf sichtbare
 * Zeichen prüfen; die tenant-/RLS-gebundene Abfrage liefert deshalb nur IDs.
 * Verspätet eingelegte Vorgänge bleiben offen, bis eine Wiedereinsetzungs- oder
 * Dispositionsentscheidung dokumentiert ist.
 *
 * Einlegungstag ist der Berliner Kalendertag des als UTC gespeicherten Zeitpunkts
 * (`timestamp without time zone`) wie in `filingWithinDeadline`: `AT TIME ZONE
 * 'UTC'` macht daraus den Zeitpunkt, `AT TIME ZONE 'Europe/Berlin'` die Berliner
 * Wanduhrzeit, die `::date` schneidet. Das Ergebnis hängt nicht von der Zeitzone
 * der DB-Sitzung ab. Die Begründung prüft dieselbe Funktion wie die
 * Datenbank-Constraint.
 */
export function einspruchVorab(tx: TxClient, horizont: Date): Promise<BescheidVorab> {
  return tx.$queryRaw<VorabZeile[]>`
        SELECT "id", "verspaetet", "ohneBegruendung"
          FROM (
            SELECT "id",
                   COALESCE(
                     (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
                       > "appeal_deadline",
                     false
                   ) AS "verspaetet",
                   ("status" = 'BESTANDSKRAEFTIG'
                     AND "legal_final_reason" IS NOT NULL
                     AND NOT app.legal_final_reason_sufficient("legal_final_reason"))
                     AS "ohneBegruendung"
              FROM public."tax_notice"
             WHERE "appeal_deadline" IS NOT NULL
               AND "appeal_deadline" <= ${horizont}
          ) AS "vorab"
         WHERE "verspaetet" OR "ohneBegruendung"
         ORDER BY "id"
      `.then(vorabListen);
}

/** Vorabfrage der Klagefristen; Einlegungstag (Berliner Kalendertag) wie bei `einspruchVorab`. */
export function klageVorab(tx: TxClient, horizont: Date): Promise<BescheidVorab> {
  return tx.$queryRaw<VorabZeile[]>`
        SELECT "id", "verspaetet", "ohneBegruendung"
          FROM (
            SELECT "id",
                   COALESCE(
                     (("klage_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
                       > "klage_deadline",
                     false
                   ) AS "verspaetet",
                   ("status" = 'BESTANDSKRAEFTIG'
                     AND "legal_final_reason" IS NOT NULL
                     AND NOT app.legal_final_reason_sufficient("legal_final_reason"))
                     AS "ohneBegruendung"
              FROM public."tax_notice"
             WHERE "klage_deadline" IS NOT NULL
               AND "klage_deadline" <= ${horizont}
          ) AS "vorab"
         WHERE "verspaetet" OR "ohneBegruendung"
         ORDER BY "id"
      `.then(vorabListen);
}
