// Fachkatalog: TAX-CONTROL-STATUS-001 — gemeinsame Teile der drei Bescheidquellen
// (Einspruchsfrist, Klagefrist, interner Prüftermin).

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { NOTICE_KIND_LABELS } from '@/lib/domain-labels';

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

/** Bestandskraft-Disposition fehlt: Status oder einer der drei Nachweise fehlt. */
export const DISPOSITION_FEHLT: Prisma.TaxNoticeWhereInput = {
  OR: [
    { status: { not: 'BESTANDSKRAEFTIG' } },
    { legalFinalAt: null },
    { legalFinalBy: null },
    { legalFinalReason: null },
  ],
};

/** Vollständig dokumentierte Bestandskraft-Disposition (Rückschau-Zweig). */
export const DISPOSITION_DOKUMENTIERT: Prisma.TaxNoticeWhereInput = {
  status: 'BESTANDSKRAEFTIG',
  legalFinalAt: { not: null },
  legalFinalBy: { not: null },
  legalFinalReason: { not: null },
};

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
    Boolean(n.legalFinalAt && n.legalFinalBy && n.legalFinalReason?.trim())
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

/**
 * IDs der nach Fristende dokumentierten Einlegungen. Prisma kann zwei Spalten in
 * einem normalen Where-Objekt nicht portabel vergleichen; die tenant-/RLS-
 * gebundene Vorabfrage liefert deshalb nur diese IDs. Die Vorgänge bleiben im
 * Kontrollbuch offen, bis eine Wiedereinsetzungs-/Dispositionsentscheidung
 * dokumentiert ist.
 */
export function verspaeteteEinspruchsIds(tx: TxClient, horizont: Date): Promise<string[]> {
  return tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM public."tax_notice"
         WHERE "appeal_deadline" IS NOT NULL
           AND "appeal_deadline" <= ${horizont}
           AND "appeal_filed_at" IS NOT NULL
           AND ("appeal_filed_at" AT TIME ZONE 'UTC')::date > "appeal_deadline"
      `.then((rows) => rows.map((row) => row.id));
}

export function verspaeteteKlageIds(tx: TxClient, horizont: Date): Promise<string[]> {
  return tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM public."tax_notice"
         WHERE "klage_deadline" IS NOT NULL
           AND "klage_deadline" <= ${horizont}
           AND "klage_filed_at" IS NOT NULL
           AND ("klage_filed_at" AT TIME ZONE 'UTC')::date > "klage_deadline"
      `.then((rows) => rows.map((row) => row.id));
}
