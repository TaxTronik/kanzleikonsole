// Fachkatalog: TAX-CONTROL-STATUS-001, TAX-NOTICE-APPEAL-001 — Quelle
// Bescheidprüffälle/Einspruchsfristen.

import type { Prisma } from '@prisma/client';
import { filingWithinDeadline, taxNoticeFristErledigt } from '../eintrag';
import {
  abschluss,
  bescheidTitel,
  type BescheidVorab,
  dispositionDokumentiert,
  dispositionFehlt,
  dispositionVorhanden,
  type Einlegungsergebnis,
  einspruchVorab,
  kontrollzustand,
} from './bescheid';
import { type KontrollbuchQuelle, seitenAbfrage, verantwortung } from './typen';

const SELECT = {
  id: true,
  clientId: true,
  kind: true,
  period: true,
  appealDeadline: true,
  manualReviewRequired: true,
  status: true,
  reviewedAt: true,
  reviewedBy: true,
  appealFiledAt: true,
  appealFiledBy: true,
  legalFinalAt: true,
  legalFinalBy: true,
  legalFinalReason: true,
  client: { select: { name: true } },
} satisfies Prisma.TaxNoticeSelect;

type Row = Prisma.TaxNoticeGetPayload<{ select: typeof SELECT }>;

function einlegung(n: Row): Einlegungsergebnis {
  const filingTimely = filingWithinDeadline(n.appealFiledAt, n.appealFiledBy, n.appealDeadline);
  return {
    filingTimely,
    filingLate: Boolean(n.appealFiledAt && n.appealFiledBy && !filingTimely),
    disposition: dispositionDokumentiert(filingTimely, n),
  };
}

function kontrollhinweis(n: Row, erledigt: boolean, ergebnis: Einlegungsergebnis): string | null {
  if (ergebnis.filingLate && !ergebnis.disposition) {
    return 'Einspruch wurde erst nach dem dokumentierten Fristende eingelegt; Wiedereinsetzung oder fachliche Disposition ist offen.';
  }
  if (!erledigt && n.manualReviewRequired) {
    return 'Frist ist ein technischer Kontrollvorschlag; die fachliche Freigabe ist noch offen.';
  }
  if (!erledigt && !['NEU', 'GEPRUEFT'].includes(n.status)) {
    return 'Verfahrensstatus vorhanden, aber Einlegungs- oder Dispositionsnachweis unvollständig.';
  }
  return null;
}

type Quelle = KontrollbuchQuelle<Row, Prisma.TaxNoticeWhereInput, BescheidVorab>;

export const einspruchsfristen: Quelle = {
  rang: 1,
  aktiv: (quellen) => quellen.taxNotices,
  vorab: (tx, k) => einspruchVorab(tx, k.horizont),
  where(k, vorab) {
    const lateIds = vorab.verspaetet;
    const filingMissing: Prisma.TaxNoticeWhereInput = {
      OR: [{ appealFiledAt: null }, { appealFiledBy: null }],
    };
    // Laut Vorabfrage keine fristgerechte Einlegung (fehlt oder verspätet) bzw.
    // fristgerecht eingelegt; beide Teile ergänzen sich.
    const ohneFristgerechteEinlegung: Prisma.TaxNoticeWhereInput = lateIds.length
      ? { OR: [filingMissing, { id: { in: lateIds } }] }
      : filingMissing;
    const fristgerechtEingelegt: Prisma.TaxNoticeWhereInput = {
      appealFiledAt: { not: null },
      appealFiledBy: { not: null },
      ...(lateIds.length ? { id: { notIn: lateIds } } : {}),
    };
    const offen: Prisma.TaxNoticeWhereInput = {
      appealDeadline: { lte: k.horizont },
      AND: [ohneFristgerechteEinlegung, dispositionFehlt(vorab.ohneBegruendung)],
    };
    const rueckschau: Prisma.TaxNoticeWhereInput = {
      appealDeadline: { gte: k.rueckschau, lte: k.horizont },
    };
    const erledigt: Prisma.TaxNoticeWhereInput = {
      ...rueckschau,
      OR: [fristgerechtEingelegt, dispositionVorhanden(vorab.ohneBegruendung)],
    };
    const basis: Prisma.TaxNoticeWhereInput = { appealDeadline: { not: null } };
    const fenster = k.nurOffene ? offen : { OR: [offen, erledigt] };
    return {
      fenster: { ...basis, ...fenster, ...k.visibleClient },
      // Verspätet dokumentierte Einlegungen entscheidet erst toEintrag; ohne sie
      // ist jede Zeile des offenen Zweigs sicher offen.
      offen: {
        ...basis,
        ...offen,
        ...(lateIds.length ? { id: { notIn: lateIds } } : {}),
        ...k.visibleClient,
      },
      offenVorbehalt: lateIds.length
        ? { ...basis, ...offen, id: { in: lateIds }, ...k.visibleClient }
        : null,
      // Dokumentierte Disposition ohne fristgerechte Einlegung schließt
      // unabhängig vom Einlegungstag; sicher erledigt, seitenweise geladen.
      erledigt: k.nurOffene
        ? null
        : {
            ...basis,
            ...rueckschau,
            AND: [ohneFristgerechteEinlegung, dispositionVorhanden(vorab.ohneBegruendung)],
            ...k.visibleClient,
          },
      // Ob eine laut Vorabfrage fristgerechte Einlegung die Frist wahrt,
      // entscheidet toEintrag (wie bei offenVorbehalt); vollständig geladen.
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
        (richtung) => ({ appealDeadline: richtung }),
        { id: 'asc' },
      ),
      select: SELECT,
    }),
  count: (tx, where, faellig) =>
    tx.taxNotice.count({ where: faellig ? { AND: [where, { appealDeadline: faellig }] } : where }),
  bezug: (n) => ({
    clientId: n.clientId,
    staffIds: [n.reviewedBy, n.appealFiledBy, n.legalFinalBy],
  }),
  toEintrag(n, personen) {
    const verantwortlich = verantwortung(personen, n.clientId);
    const erledigt = taxNoticeFristErledigt(n.status, n);
    const ergebnis = einlegung(n);
    return {
      quelle: 'EINSPRUCHSFRIST',
      kontrollart: n.manualReviewRequired
        ? 'REVIEW_PENDING_CONTROL_PROPOSAL'
        : 'CALCULATED_CONTROL_PROPOSAL',
      id: n.id,
      titel: bescheidTitel(n.kind, n.period),
      clientId: n.clientId,
      clientName: n.client.name,
      faelligAm: n.appealDeadline!,
      erledigt,
      kontrollzustand: kontrollzustand(erledigt, ergebnis.disposition),
      kontrollhinweis: kontrollhinweis(n, erledigt, ergebnis),
      ...abschluss(
        ergebnis,
        { at: n.appealFiledAt, by: n.appealFiledBy },
        { at: n.legalFinalAt, by: n.legalFinalBy },
        personen.name,
      ),
      verantwortlich: verantwortlich.name,
      verantwortlichId: verantwortlich.id,
      href: `/staff/clients/${n.clientId}/notices`,
    };
  },
};
