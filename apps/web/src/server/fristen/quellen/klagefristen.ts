// Fachkatalog: TAX-CONTROL-STATUS-001 — Quelle Klagefristen (§ 47 FGO).

import type { Prisma } from '@prisma/client';
import { filingWithinDeadline, taxNoticeKlageFristErledigt } from '../eintrag';
import {
  abschluss,
  bescheidTitel,
  type BescheidVorab,
  dispositionDokumentiert,
  dispositionFehlt,
  dispositionVorhanden,
  type Einlegungsergebnis,
  klageVorab,
  kontrollzustand,
} from './bescheid';
import { type KontrollbuchQuelle, seitenAbfrage, verantwortung } from './typen';

const SELECT = {
  id: true,
  clientId: true,
  kind: true,
  period: true,
  klageDeadline: true,
  manualReviewRequired: true,
  status: true,
  appealResolvedAt: true,
  klageFiledAt: true,
  klageFiledBy: true,
  legalFinalAt: true,
  legalFinalBy: true,
  legalFinalReason: true,
  client: { select: { name: true } },
} satisfies Prisma.TaxNoticeSelect;

type Row = Prisma.TaxNoticeGetPayload<{ select: typeof SELECT }>;

function einlegung(k: Row): Einlegungsergebnis {
  const filingTimely = filingWithinDeadline(k.klageFiledAt, k.klageFiledBy, k.klageDeadline);
  return {
    filingTimely,
    filingLate: Boolean(k.klageFiledAt && k.klageFiledBy && !filingTimely),
    disposition: dispositionDokumentiert(filingTimely, k),
  };
}

function kontrollhinweis(k: Row, erledigt: boolean, ergebnis: Einlegungsergebnis): string | null {
  if (ergebnis.filingLate && !ergebnis.disposition) {
    return 'Klage wurde erst nach dem dokumentierten Fristende eingereicht; Wiedereinsetzung oder fachliche Disposition ist offen.';
  }
  if (!erledigt && k.status === 'ABGEHOLFEN') {
    return 'Die bereits dokumentierte Klagefrist bleibt trotz Abhilfe-Status bis zum Einreichungs- oder Dispositionsnachweis in Kontrolle.';
  }
  if (!erledigt && ['KLAGE', 'BESTANDSKRAEFTIG'].includes(k.status)) {
    return 'Abschlussstatus vorhanden, aber Klage- oder Dispositionsnachweis unvollständig.';
  }
  return null;
}

// TAX-CONTROL-STATUS-001: Klagefristen sind erst nach einer Einspruchs- oder
// Teil-Einspruchsentscheidung offen, nicht bereits bei TEILABHILFE. Im
// Rückschau-Fenster auch nachgewiesene Abschlüsse.
export const klagefristen: KontrollbuchQuelle<Row, Prisma.TaxNoticeWhereInput, BescheidVorab> = {
  rang: 3,
  aktiv: (quellen) => quellen.taxNotices,
  vorab: (tx, k) => klageVorab(tx, k.horizont),
  where(k, vorab) {
    const lateIds = vorab.verspaetet;
    const filingMissing: Prisma.TaxNoticeWhereInput = {
      OR: [{ klageFiledAt: null }, { klageFiledBy: null }],
    };
    // Laut Vorabfrage keine fristgerechte Einreichung (fehlt oder verspätet) bzw.
    // fristgerecht eingereicht; beide Teile ergänzen sich.
    const ohneFristgerechteEinlegung: Prisma.TaxNoticeWhereInput = lateIds.length
      ? { OR: [filingMissing, { id: { in: lateIds } }] }
      : filingMissing;
    const fristgerechtEingelegt: Prisma.TaxNoticeWhereInput = {
      klageFiledAt: { not: null },
      klageFiledBy: { not: null },
      ...(lateIds.length ? { id: { notIn: lateIds } } : {}),
    };
    const offen: Prisma.TaxNoticeWhereInput = {
      status: {
        in: [
          'TEILEINSPRUCHSENTSCHEIDUNG',
          'ZURUECKGEWIESEN',
          // TAX-CONTROL-STATUS-001: Ein spaeterer ABGEHOLFEN-Status beseitigt
          // eine bereits persistierte Klagefrist nicht. Bis ein fristwahrender
          // Einreichungs- oder Bestandskraft-/Dispositionsnachweis vorliegt,
          // bleibt sie fail-closed in der Kontrollsicht offen.
          'ABGEHOLFEN',
          'KLAGE',
          'BESTANDSKRAEFTIG',
        ],
      },
      klageDeadline: { lte: k.horizont },
      AND: [ohneFristgerechteEinlegung, dispositionFehlt(vorab.ohneBegruendung)],
    };
    const rueckschau: Prisma.TaxNoticeWhereInput = {
      klageDeadline: { gte: k.rueckschau, lte: k.horizont },
    };
    const erledigt: Prisma.TaxNoticeWhereInput = {
      ...rueckschau,
      OR: [fristgerechtEingelegt, dispositionVorhanden(vorab.ohneBegruendung)],
    };
    const basis: Prisma.TaxNoticeWhereInput = { klageDeadline: { not: null } };
    const fenster = k.nurOffene ? offen : { OR: [offen, erledigt] };
    return {
      fenster: { ...basis, ...fenster, ...k.visibleClient },
      offen: {
        ...basis,
        ...offen,
        ...(lateIds.length ? { id: { notIn: lateIds } } : {}),
        ...k.visibleClient,
      },
      offenVorbehalt: lateIds.length
        ? { ...basis, ...offen, id: { in: lateIds }, ...k.visibleClient }
        : null,
      // Wie bei den Einspruchsfristen: Disposition ohne fristgerechte Einreichung
      // ist sicher erledigt; eine laut Vorabfrage fristgerechte entscheidet toEintrag.
      erledigt: k.nurOffene
        ? null
        : {
            ...basis,
            ...rueckschau,
            AND: [ohneFristgerechteEinlegung, dispositionVorhanden(vorab.ohneBegruendung)],
            ...k.visibleClient,
          },
      erledigtVorbehalt: k.nurOffene
        ? null
        : { ...basis, ...rueckschau, ...fristgerechtEingelegt, ...k.visibleClient },
    };
  },
  query: (tx, where, seite) =>
    tx.taxNotice.findMany({
      where,
      ...seitenAbfrage<Prisma.TaxNoticeOrderByWithRelationInput>(
        seite,
        (richtung) => ({ klageDeadline: richtung }),
        { id: 'asc' },
      ),
      select: SELECT,
    }),
  count: (tx, where, faellig) =>
    tx.taxNotice.count({ where: faellig ? { AND: [where, { klageDeadline: faellig }] } : where }),
  bezug: (k) => ({ clientId: k.clientId, staffIds: [k.klageFiledBy, k.legalFinalBy] }),
  toEintrag(k, personen) {
    if (!k.klageDeadline) return null;
    const verantwortlich = verantwortung(personen, k.clientId);
    const erledigt = taxNoticeKlageFristErledigt(k.status, k);
    const ergebnis = einlegung(k);
    return {
      quelle: 'KLAGEFRIST',
      kontrollart: k.manualReviewRequired
        ? 'REVIEW_PENDING_CONTROL_PROPOSAL'
        : 'CALCULATED_CONTROL_PROPOSAL',
      id: k.id,
      titel: `${bescheidTitel(k.kind, k.period)} (Klage FG)`,
      clientId: k.clientId,
      clientName: k.client.name,
      faelligAm: k.klageDeadline,
      erledigt,
      kontrollzustand: kontrollzustand(erledigt, ergebnis.disposition),
      kontrollhinweis: kontrollhinweis(k, erledigt, ergebnis),
      // #11: Erledigung = tatsächliche Klageeinreichung (wer/wann), nicht die
      // Einspruchsentscheidung (= Fristbeginn) bzw. der Bescheidprüfer. Fallback
      // auf Abschluss-/Entscheidungsdaten nur für Altbestand ohne die
      // belastbaren klageFiled*-Felder.
      ...abschluss(
        ergebnis,
        { at: k.klageFiledAt, by: k.klageFiledBy },
        { at: k.legalFinalAt, by: k.legalFinalBy },
        personen.name,
      ),
      verantwortlich: verantwortlich.name,
      verantwortlichId: verantwortlich.id,
      href: `/staff/clients/${k.clientId}/notices`,
    };
  },
};
