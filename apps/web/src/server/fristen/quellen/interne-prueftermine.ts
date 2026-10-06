// Fachkatalog: TAX-CONTROL-STATUS-001, TAX-NOTICE-APPEAL-001 — interne
// Risikotermine ohne berechnete Rechtsbehelfsfrist.
//
// Wenn die Bekanntgabe-/Fristgrundlage keine belastbare Rechtsbehelfsfrist
// erlaubt, darf ein gespeicherter interner Risikotermin nicht aus der Kontrolle
// verschwinden. Er ist ausdrücklich KEINE Einspruchsfrist und bleibt bis zu
// einer echten Frist offen. Das Produkt besitzt hierfür noch keinen eigenen
// strukturierten Abschlussgrund; ein generischer BESTANDSKRAEFTIG-Satz darf
// deshalb auch bei Legacy-/Importdaten nicht als Erledigung fehlgedeutet werden.

import type { Prisma } from '@prisma/client';
import { bescheidTitel } from './bescheid';
import { type KontrollbuchQuelle, seitenAbfrage, verantwortung } from './typen';

const SELECT = {
  id: true,
  clientId: true,
  kind: true,
  period: true,
  internalRiskDeadline: true,
  deadlineCalculationStatus: true,
  client: { select: { name: true } },
} satisfies Prisma.TaxNoticeSelect;

type Row = Prisma.TaxNoticeGetPayload<{ select: typeof SELECT }>;

export const internePrueftermine: KontrollbuchQuelle<Row, Prisma.TaxNoticeWhereInput> = {
  rang: 2,
  aktiv: (quellen) => quellen.taxNotices,
  where(k) {
    // Immer offen: kein Rückschau-Zweig, auch nicht ohne `nurOffene`.
    const offen: Prisma.TaxNoticeWhereInput = {
      appealDeadline: null,
      internalRiskDeadline: { lte: k.horizont },
      deadlineCalculationStatus: { in: ['MANUAL_REVIEW', 'RISK_ONLY'] },
      ...k.visibleClient,
    };
    return { fenster: offen, offen, offenVorbehalt: null, erledigt: null };
  },
  query: (tx, where, seite) =>
    tx.taxNotice.findMany({
      where,
      ...seitenAbfrage<Prisma.TaxNoticeOrderByWithRelationInput>(seite, [
        { internalRiskDeadline: 'asc' },
        { id: 'asc' },
      ]),
      select: SELECT,
    }),
  count: (tx, where, faellig) =>
    tx.taxNotice.count({
      where: faellig ? { AND: [where, { internalRiskDeadline: faellig }] } : where,
    }),
  bezug: (n) => ({ clientId: n.clientId, staffIds: [] }),
  toEintrag(n, personen) {
    if (!n.internalRiskDeadline) return null;
    const verantwortlich = verantwortung(personen, n.clientId);
    return {
      // Technisch dieselbe Bescheidquelle, aber mit eigener Anzeigeart: weder
      // UI noch CSV dürfen aus dem Risikotermin eine Einspruchsfrist machen.
      quelle: 'EINSPRUCHSFRIST',
      kontrollart: 'INTERNAL_RISK',
      artLabel: 'Interner Prüftermin',
      id: n.id,
      titel: `Interner Prüftermin: ${bescheidTitel(n.kind, n.period)} (keine Rechtsbehelfsfrist)`,
      clientId: n.clientId,
      clientName: n.client.name,
      faelligAm: n.internalRiskDeadline,
      erledigt: false,
      kontrollzustand: 'OPEN',
      kontrollhinweis:
        'Interner Risikotermin ohne berechnete Rechtsbehelfsfrist. Bekanntgabe und Fristgrundlage fachlich prüfen; ein eigener strukturierter Abschlussgrund ist noch nicht implementiert.',
      erledigtAm: null,
      erledigtVon: null,
      verantwortlich: verantwortlich.name,
      verantwortlichId: verantwortlich.id,
      href: `/staff/clients/${n.clientId}/notices`,
    };
  },
};
