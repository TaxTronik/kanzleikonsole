// Fachkatalog: TAX-CONTROL-STATUS-001 — Quelle Steuertermine.

import type { Prisma } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { taxDeadlineErledigt } from '../eintrag';
import { type KontrollbuchQuelle, seitenAbfrage, verantwortung } from './typen';

const SELECT = {
  id: true,
  clientId: true,
  kind: true,
  period: true,
  dueDate: true,
  status: true,
  completedAt: true,
  completedByStaff: true,
  client: { select: { name: true } },
} satisfies Prisma.TaxDeadlineSelect;

type Row = Prisma.TaxDeadlineGetPayload<{ select: typeof SELECT }>;

function kontrollhinweis(d: Row, erledigt: boolean): string | null {
  if (d.status === 'SKIPPED') {
    return 'Übersprungen ohne strukturierten Grund und fachliche Freigabe.';
  }
  return d.status === 'DONE' && !erledigt ? 'Erledigungszeit oder handelnde Person fehlt.' : null;
}

export const steuertermine: KontrollbuchQuelle<Row, Prisma.TaxDeadlineWhereInput> = {
  rang: 0,
  aktiv: (quellen) => quellen.taxNotices,
  where(k) {
    const offen: Prisma.TaxDeadlineWhereInput = {
      dueDate: { lte: k.horizont },
      OR: [
        { status: { not: 'DONE' } },
        { status: 'DONE', completedAt: null },
        { status: 'DONE', completedByStaff: null },
      ],
    };
    const erledigt: Prisma.TaxDeadlineWhereInput = {
      status: 'DONE',
      completedAt: { not: null },
      completedByStaff: { not: null },
      dueDate: { gte: k.rueckschau, lte: k.horizont },
    };
    const fenster = k.nurOffene ? offen : { OR: [offen, erledigt] };
    return {
      fenster: { ...fenster, ...k.visibleClient },
      offen: { ...offen, ...k.visibleClient },
      offenVorbehalt: null,
      erledigt: k.nurOffene ? null : { ...erledigt, ...k.visibleClient },
      erledigtVorbehalt: null,
    };
  },
  query: (tx, where, seite) =>
    tx.taxDeadline.findMany({
      where,
      ...seitenAbfrage<Prisma.TaxDeadlineOrderByWithRelationInput>(
        seite,
        (richtung) => ({ dueDate: richtung }),
        { id: 'asc' },
      ),
      select: SELECT,
    }),
  count: (tx, where, faellig) =>
    tx.taxDeadline.count({ where: faellig ? { AND: [where, { dueDate: faellig }] } : where }),
  bezug: (d) => ({ clientId: d.clientId, staffIds: [d.completedByStaff] }),
  toEintrag(d, personen) {
    const verantwortlich = verantwortung(personen, d.clientId);
    const erledigt = taxDeadlineErledigt(d.status, d.completedAt, d.completedByStaff);
    return {
      quelle: 'STEUERTERMIN',
      kontrollart: 'OPERATIONAL_DUE_DATE',
      id: d.id,
      titel: `${SCHEDULE_LABELS[d.kind] ?? d.kind} ${d.period}`,
      clientId: d.clientId,
      clientName: d.client.name,
      faelligAm: d.dueDate,
      erledigt,
      kontrollzustand: erledigt ? 'CLOSED_FULFILLED' : 'OPEN',
      kontrollhinweis: kontrollhinweis(d, erledigt),
      erledigtAm: d.completedAt,
      erledigtVon: personen.name(d.completedByStaff),
      verantwortlich: verantwortlich.name,
      verantwortlichId: verantwortlich.id,
      href: `/staff/tax-deadlines/group?kind=${d.kind}&period=${encodeURIComponent(d.period)}&scope=all`,
    };
  },
};
