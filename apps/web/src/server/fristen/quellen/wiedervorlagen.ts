// Fachkatalog: TAX-CONTROL-STATUS-001 — Quelle Wiedervorlagen (nur mit Mandant).

import type { Prisma } from '@prisma/client';
import { clientAccessFilter } from '@/server/auth/client-access-filter';
import { type KontrollbuchQuelle, seitenAbfrage } from './typen';

const SELECT = {
  id: true,
  clientId: true,
  subject: true,
  dueDate: true,
  // Gemeinsam angelegte Zuweisungen haben denselben Zeitstempel; die ID der
  // Person entscheidet dann stabil, wer als erste Zuweisung führt.
  assignees: { select: { staffId: true }, orderBy: [{ createdAt: 'asc' }, { staffId: 'asc' }] },
  doneAt: true,
  doneByStaff: true,
  client: { select: { name: true } },
} satisfies Prisma.ClientReminderSelect;

type Row = Prisma.ClientReminderGetPayload<{ select: typeof SELECT }>;

export const wiedervorlagen: KontrollbuchQuelle<Row, Prisma.ClientReminderWhereInput> = {
  rang: 5,
  aktiv: (quellen) => quellen.reminders,
  where(k) {
    const offen: Prisma.ClientReminderWhereInput = {
      dueDate: { lte: k.horizont },
      OR: [{ doneAt: null }, { doneByStaff: null }],
    };
    const erledigt: Prisma.ClientReminderWhereInput = {
      doneAt: { not: null },
      doneByStaff: { not: null },
      dueDate: { gte: k.rueckschau, lte: k.horizont },
    };
    // „Meine“: eigene Zuweisung oder, ohne Zuweisung, Hauptbearbeitung des Mandanten.
    const zustaendig: Prisma.ClientReminderWhereInput | undefined = k.nurStaffId
      ? {
          OR: [
            { assignees: { some: { staffId: k.nurStaffId } } },
            { assignees: { none: {} }, client: k.responsibleClient },
          ],
        }
      : undefined;
    const mit = (zweig: Prisma.ClientReminderWhereInput): Prisma.ClientReminderWhereInput => ({
      ...clientAccessFilter(k.clientAccess),
      AND: [
        // Das Fristenbuch fuehrt MANDANTEN-Fristen. Interne Aufgaben ohne
        // Mandantenbezug haben darin nichts zu suchen (und keinen Platz: der
        // Eintrag verlangt Mandant + Name). Fuer Admin/Partner (Regel `{}`)
        // setzt der Relationsfilter keine Bedingung, daher explizit.
        { NOT: { clientId: null } },
        zweig,
        ...(zustaendig ? [zustaendig] : []),
      ],
    });
    return {
      fenster: mit(k.nurOffene ? offen : { OR: [offen, erledigt] }),
      offen: mit(offen),
      offenVorbehalt: null,
      erledigt: k.nurOffene ? null : mit(erledigt),
    };
  },
  query: (tx, where, seite) =>
    tx.clientReminder.findMany({
      where,
      ...seitenAbfrage<Prisma.ClientReminderOrderByWithRelationInput>(seite, [
        { dueDate: 'asc' },
        { id: 'asc' },
      ]),
      select: SELECT,
    }),
  count: (tx, where, faellig) =>
    tx.clientReminder.count({ where: faellig ? { AND: [where, { dueDate: faellig }] } : where }),
  bezug: (w) => ({
    clientId: w.clientId,
    staffIds: [...w.assignees.map((a) => a.staffId), w.doneByStaff],
  }),
  toEintrag(w, personen) {
    // Bei mehreren Zustaendigen fuehrt die erste Zuweisung — das Fristenbuch
    // kennt genau eine verantwortliche Person je Eintrag.
    const clientId = w.clientId!;
    const verantwortlichId = w.assignees[0]?.staffId ?? personen.hauptbearbeiter(clientId);
    const erledigt = Boolean(w.doneAt && w.doneByStaff);
    return {
      quelle: 'WIEDERVORLAGE',
      kontrollart: 'OPERATIONAL_DUE_DATE',
      id: w.id,
      titel: w.subject,
      clientId,
      clientName: w.client!.name,
      faelligAm: w.dueDate,
      erledigt,
      kontrollzustand: erledigt ? 'CLOSED_FULFILLED' : 'OPEN',
      kontrollhinweis:
        w.doneAt && !w.doneByStaff ? 'Erledigungszeit vorhanden, handelnde Person fehlt.' : null,
      erledigtAm: w.doneAt,
      erledigtVon: personen.name(w.doneByStaff),
      verantwortlich: personen.name(verantwortlichId),
      verantwortlichId,
      href: `/staff/clients/${clientId}`,
    };
  },
};
