// Fachkatalog: TAX-CONTROL-STATUS-001 — Quelle Mandantenanforderungen.
// Kernfunktion: unabhängig von Modulschaltern immer aktiv.

import type { Prisma } from '@prisma/client';
import { requestErledigt } from '../eintrag';
import { type KontrollbuchQuelle, seitenAbfrage, verantwortung } from './typen';

const SELECT = {
  id: true,
  clientId: true,
  title: true,
  dueAt: true,
  status: true,
  closedAt: true,
  closedByStaff: true,
  client: { select: { name: true } },
} satisfies Prisma.RequestSelect;

type Row = Prisma.RequestGetPayload<{ select: typeof SELECT }>;

function kontrollhinweis(r: Row, erledigt: boolean): string | null {
  if (r.status === 'CANCELLED') return 'Storniert ohne strukturierten Abschlussgrund.';
  return r.status === 'CLOSED' && !erledigt ? 'Abschlusszeit oder handelnde Person fehlt.' : null;
}

export const anforderungen: KontrollbuchQuelle<Row, Prisma.RequestWhereInput> = {
  rang: 4,
  aktiv: () => true,
  where(k) {
    const offen: Prisma.RequestWhereInput = {
      dueAt: { lte: k.horizont },
      OR: [
        { status: { not: 'CLOSED' } },
        { status: 'CLOSED', closedAt: null },
        { status: 'CLOSED', closedByStaff: null },
      ],
    };
    const erledigt: Prisma.RequestWhereInput = {
      status: 'CLOSED',
      closedAt: { not: null },
      closedByStaff: { not: null },
      dueAt: { gte: k.rueckschau, lte: k.horizont },
    };
    const basis: Prisma.RequestWhereInput = { dueAt: { not: null } };
    const fenster = k.nurOffene ? offen : { OR: [offen, erledigt] };
    return {
      fenster: { ...basis, ...fenster, ...k.visibleClient },
      offen: { ...basis, ...offen, ...k.visibleClient },
      offenVorbehalt: null,
      erledigt: k.nurOffene ? null : { ...basis, ...erledigt, ...k.visibleClient },
    };
  },
  query: (tx, where, seite) =>
    tx.request.findMany({
      where,
      ...seitenAbfrage<Prisma.RequestOrderByWithRelationInput>(seite, [
        { dueAt: 'asc' },
        { id: 'asc' },
      ]),
      select: SELECT,
    }),
  count: (tx, where, faellig) =>
    tx.request.count({ where: faellig ? { AND: [where, { dueAt: faellig }] } : where }),
  bezug: (r) => ({ clientId: r.clientId, staffIds: [r.closedByStaff] }),
  toEintrag(r, personen) {
    const verantwortlich = verantwortung(personen, r.clientId);
    const erledigt = requestErledigt(r.status, r.closedAt, r.closedByStaff);
    return {
      quelle: 'ANFORDERUNG',
      kontrollart: 'OPERATIONAL_DUE_DATE',
      id: r.id,
      titel: r.title,
      clientId: r.clientId,
      clientName: r.client.name,
      // `fenster`/`offen`/`erledigt` verlangen eine Fälligkeit.
      faelligAm: r.dueAt!,
      erledigt,
      kontrollzustand: erledigt ? 'CLOSED_FULFILLED' : 'OPEN',
      kontrollhinweis: kontrollhinweis(r, erledigt),
      erledigtAm: erledigt ? r.closedAt : null,
      erledigtVon: erledigt ? personen.name(r.closedByStaff) : null,
      verantwortlich: verantwortlich.name,
      verantwortlichId: verantwortlich.id,
      href: `/staff/requests/${r.id}`,
    };
  },
};
