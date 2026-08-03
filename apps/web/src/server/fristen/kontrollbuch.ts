// =============================================================================
// Fristenkontrollbuch — Loader.
//
// Aggregiert die vier fristenführenden Quellen (Steuertermine, Einspruchs-
// fristen, Anforderungen, Wiedervorlagen) zu einer Kontrollsicht. Eigener
// Zustand entsteht hier NICHT (siehe eintrag.ts) — Erledigung wird aus den
// Quellmodulen abgelesen, wo sie auditiert geführt wird.
//
// Fensterlogik: OFFENE Fristen erscheinen bis zum Horizont (heute + tage)
// OHNE untere Grenze — eine überfällige Frist verschwindet nie durch
// Zeitablauf. ERLEDIGTE erscheinen nur im Fenster [heute − tage, Horizont]
// (Erledigungsnachweis der jüngeren Vergangenheit; Vollnachweis = CSV-Export
// oder Audit-Chain).
//
// Zugriffsmodell: RESTRICTED-/vertrauliche Mandanten werden über das
// denied-Set ausgeblendet (identisch zu Kalender/Exporten).
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import type { StaffSession } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { berlinTodayUtcMidnight } from '@/lib/fmt';
import { NOTICE_KIND_LABELS } from '@/lib/domain-labels';
import {
  type FristEintrag,
  taxDeadlineErledigt,
  taxNoticeFristErledigt,
  taxNoticeKlageFristErledigt,
  requestErledigt,
  sortEintraege,
} from './eintrag';

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

export interface KontrollbuchOptions {
  /** Horizont in Tagen (Zukunft) und Rückschau für Erledigte. */
  tage: number;
  /** Erledigte bereits in den Quellabfragen ausschließen. */
  nurOffene?: boolean;
  /** Nur Einträge, für die diese Person verantwortlich ist. */
  nurStaffId?: string | null;
}

export async function loadKontrollbuch(
  tx: TxClient,
  session: StaffSession,
  opts: KontrollbuchOptions,
): Promise<FristEintrag[]> {
  const heute = berlinTodayUtcMidnight();
  const horizont = new Date(heute.getTime() + opts.tage * 86400000);
  const rueckschau = new Date(heute.getTime() - opts.tage * 86400000);

  const denied = await inaccessibleClientIdsFor(tx, session);
  const notDenied = denied.length ? { clientId: { notIn: denied } } : {};
  const responsibleClient: Prisma.ClientWhereInput | undefined = opts.nurStaffId
    ? {
        responsibilities: {
          some: { role: 'HAUPTBEARBEITER', staffId: opts.nurStaffId },
        },
      }
    : undefined;

  const deadlineWindow: Prisma.TaxDeadlineWhereInput = opts.nurOffene
    ? { status: { notIn: ['DONE', 'SKIPPED'] }, dueDate: { lte: horizont } }
    : {
        OR: [
          { status: { notIn: ['DONE', 'SKIPPED'] }, dueDate: { lte: horizont } },
          { status: { in: ['DONE', 'SKIPPED'] }, dueDate: { gte: rueckschau, lte: horizont } },
        ],
      };
  const noticeWindow: Prisma.TaxNoticeWhereInput = opts.nurOffene
    ? { status: { in: ['NEU', 'GEPRUEFT'] }, appealDeadline: { lte: horizont } }
    : {
        OR: [
          { status: { in: ['NEU', 'GEPRUEFT'] }, appealDeadline: { lte: horizont } },
          {
            // MUSS mit taxNoticeFristErledigt (eintrag.ts) übereinstimmen —
            // sonst fallen TEILABHILFE/KLAGE-Bescheide ganz aus dem
            // Kontrollbuch (weder offen noch im Erledigungsnachweis).
            status: {
              in: [
                'EINSPRUCH',
                'ABGEHOLFEN',
                'TEILABHILFE',
                'ZURUECKGEWIESEN',
                'KLAGE',
                'RECHTSKRAEFTIG',
              ],
            },
            appealDeadline: { gte: rueckschau, lte: horizont },
          },
        ],
      };
  const klageWindow: Prisma.TaxNoticeWhereInput = opts.nurOffene
    ? {
        status: { in: ['ZURUECKGEWIESEN', 'TEILABHILFE'] },
        klageDeadline: { lte: horizont },
      }
    : {
        OR: [
          { status: { in: ['ZURUECKGEWIESEN', 'TEILABHILFE'] }, klageDeadline: { lte: horizont } },
          {
            status: { in: ['KLAGE', 'RECHTSKRAEFTIG'] },
            klageDeadline: { gte: rueckschau, lte: horizont },
          },
        ],
      };
  const requestWindow: Prisma.RequestWhereInput = opts.nurOffene
    ? { status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] }, dueAt: { lte: horizont } }
    : {
        OR: [
          { status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] }, dueAt: { lte: horizont } },
          { status: { in: ['CLOSED', 'CANCELLED'] }, dueAt: { gte: rueckschau, lte: horizont } },
        ],
      };
  const reminderWindow: Prisma.ClientReminderWhereInput = opts.nurOffene
    ? { doneAt: null, dueDate: { lte: horizont } }
    : {
        OR: [
          { doneAt: null, dueDate: { lte: horizont } },
          { doneAt: { not: null }, dueDate: { gte: rueckschau, lte: horizont } },
        ],
      };
  const reminderStaff: Prisma.ClientReminderWhereInput | undefined = opts.nurStaffId
    ? {
        OR: [
          { assignees: { some: { staffId: opts.nurStaffId } } },
          { assignees: { none: {} }, client: responsibleClient },
        ],
      }
    : undefined;

  // Offen ohne untere Grenze ODER erledigt im Fenster — je Quelle als OR
  // ausgedrückt, da „erledigt" quellspezifisch ist.
  const [deadlines, notices, klagen, requests, reminders] = await Promise.all([
    tx.taxDeadline.findMany({
      where: {
        ...notDenied,
        ...deadlineWindow,
        ...(responsibleClient ? { client: responsibleClient } : {}),
      },
      select: {
        id: true,
        clientId: true,
        kind: true,
        period: true,
        dueDate: true,
        status: true,
        completedAt: true,
        completedByStaff: true,
        client: { select: { name: true } },
      },
    }),
    tx.taxNotice.findMany({
      where: {
        ...notDenied,
        appealDeadline: { not: null },
        ...noticeWindow,
        ...(responsibleClient ? { client: responsibleClient } : {}),
      },
      select: {
        id: true,
        clientId: true,
        kind: true,
        period: true,
        appealDeadline: true,
        status: true,
        reviewedAt: true,
        reviewedBy: true,
        appealFiledAt: true,
        appealFiledBy: true,
        legalFinalAt: true,
        legalFinalBy: true,
        client: { select: { name: true } },
      },
    }),
    // Klagefristen (§ 47 FGO): offen bei ZURUECKGEWIESEN/TEILABHILFE, im
    // Rückschau-Fenster auch KLAGE/RECHTSKRAEFTIG (erledigt).
    tx.taxNotice.findMany({
      where: {
        ...notDenied,
        klageDeadline: { not: null },
        ...klageWindow,
        ...(responsibleClient ? { client: responsibleClient } : {}),
      },
      select: {
        id: true,
        clientId: true,
        kind: true,
        period: true,
        klageDeadline: true,
        status: true,
        appealResolvedAt: true,
        klageFiledAt: true,
        klageFiledBy: true,
        legalFinalAt: true,
        legalFinalBy: true,
        client: { select: { name: true } },
      },
    }),
    tx.request.findMany({
      where: {
        ...notDenied,
        dueAt: { not: null },
        ...requestWindow,
        ...(responsibleClient ? { client: responsibleClient } : {}),
      },
      select: {
        id: true,
        clientId: true,
        title: true,
        dueAt: true,
        status: true,
        client: { select: { name: true } },
      },
    }),
    tx.clientReminder.findMany({
      where: {
        ...notDenied,
        AND: [
          // Das Fristenbuch fuehrt MANDANTEN-Fristen. Interne Aufgaben ohne
          // Mandantenbezug haben darin nichts zu suchen (und keinen Platz: der
          // Eintrag verlangt Mandant + Name).
          //
          // Bewusst im AND und NICHT als eigener `clientId`-Schluessel: der
          // wuerde per Objekt-Spread den `notIn`-Filter aus `notDenied`
          // ueberschreiben — gesperrte Mandanten waeren wieder sichtbar.
          { NOT: { clientId: null } },
          reminderWindow,
          ...(reminderStaff ? [reminderStaff] : []),
        ],
      },
      select: {
        id: true,
        clientId: true,
        subject: true,
        dueDate: true,
        assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        doneAt: true,
        doneByStaff: true,
        client: { select: { name: true } },
      },
    }),
  ]);

  // Verantwortliche: Hauptbearbeiter je Mandant (eine Query) — Wiedervorlagen
  // mit eigener Zuweisung überschreiben das. Namen in einer zweiten Query.
  const clientIds = new Set<string>();
  for (const r of [...deadlines, ...notices, ...klagen, ...requests, ...reminders])
    if (r.clientId) clientIds.add(r.clientId);
  const responsibilities = clientIds.size
    ? await tx.clientResponsibility.findMany({
        where: {
          clientId: { in: [...clientIds] },
          role: 'HAUPTBEARBEITER',
          ...(opts.nurStaffId ? { staffId: opts.nurStaffId } : {}),
        },
        select: { clientId: true, staffId: true },
      })
    : [];
  const hauptbearbeiter = new Map(responsibilities.map((r) => [r.clientId, r.staffId]));

  const staffIds = new Set<string>();
  for (const sid of hauptbearbeiter.values()) staffIds.add(sid);
  for (const d of deadlines) if (d.completedByStaff) staffIds.add(d.completedByStaff);
  for (const n of notices) if (n.reviewedBy) staffIds.add(n.reviewedBy);
  for (const n of notices) if (n.appealFiledBy) staffIds.add(n.appealFiledBy);
  for (const n of notices) if (n.legalFinalBy) staffIds.add(n.legalFinalBy);
  for (const k of klagen) if (k.klageFiledBy) staffIds.add(k.klageFiledBy);
  for (const k of klagen) if (k.legalFinalBy) staffIds.add(k.legalFinalBy);
  for (const r of reminders) {
    for (const a of r.assignees) staffIds.add(a.staffId);
    if (r.doneByStaff) staffIds.add(r.doneByStaff);
  }
  const staff = staffIds.size
    ? await tx.staffUser.findMany({
        where: { id: { in: [...staffIds] } },
        select: { id: true, fullName: true },
      })
    : [];
  const staffName = new Map(staff.map((s) => [s.id, s.fullName]));

  const eintraege: FristEintrag[] = [];

  for (const d of deadlines) {
    const verantwortlichId = hauptbearbeiter.get(d.clientId) ?? null;
    eintraege.push({
      quelle: 'STEUERTERMIN',
      id: d.id,
      titel: `${SCHEDULE_LABELS[d.kind] ?? d.kind} ${d.period}`,
      clientId: d.clientId,
      clientName: d.client.name,
      faelligAm: d.dueDate,
      erledigt: taxDeadlineErledigt(d.status),
      erledigtAm: d.completedAt,
      erledigtVon: d.completedByStaff ? (staffName.get(d.completedByStaff) ?? null) : null,
      verantwortlich: verantwortlichId ? (staffName.get(verantwortlichId) ?? null) : null,
      verantwortlichId,
      href: `/staff/tax-deadlines/group?kind=${d.kind}&period=${encodeURIComponent(d.period)}&scope=all`,
    });
  }

  for (const n of notices) {
    const verantwortlichId = hauptbearbeiter.get(n.clientId) ?? null;
    eintraege.push({
      quelle: 'EINSPRUCHSFRIST',
      id: n.id,
      titel: `${KONTROLLBUCH_NOTICE_KIND_LABELS[n.kind] ?? n.kind} ${n.period}`,
      clientId: n.clientId,
      clientName: n.client.name,
      faelligAm: n.appealDeadline!,
      erledigt: taxNoticeFristErledigt(n.status),
      erledigtAm: n.appealFiledAt ?? n.legalFinalAt ?? n.reviewedAt,
      erledigtVon: n.appealFiledBy
        ? (staffName.get(n.appealFiledBy) ?? null)
        : n.legalFinalBy
          ? (staffName.get(n.legalFinalBy) ?? null)
          : n.reviewedBy
            ? (staffName.get(n.reviewedBy) ?? null)
            : null,
      verantwortlich: verantwortlichId ? (staffName.get(verantwortlichId) ?? null) : null,
      verantwortlichId,
      href: `/staff/clients/${n.clientId}/notices`,
    });
  }

  for (const k of klagen) {
    if (!k.klageDeadline) continue;
    const verantwortlichId = hauptbearbeiter.get(k.clientId) ?? null;
    eintraege.push({
      quelle: 'KLAGEFRIST',
      id: k.id,
      titel: `${KONTROLLBUCH_NOTICE_KIND_LABELS[k.kind] ?? k.kind} ${k.period} (Klage FG)`,
      clientId: k.clientId,
      clientName: k.client.name,
      faelligAm: k.klageDeadline,
      erledigt: taxNoticeKlageFristErledigt(k.status),
      // #11: Erledigung = tatsächliche Klageeinreichung (wer/wann), nicht die
      // Einspruchsentscheidung (= Fristbeginn) bzw. der Bescheidprüfer. Fallback
      // auf Abschluss-/Entscheidungsdaten nur für Altbestand ohne die
      // belastbaren klageFiled*-Felder.
      erledigtAm: k.klageFiledAt ?? k.legalFinalAt ?? k.appealResolvedAt,
      erledigtVon: k.klageFiledBy
        ? (staffName.get(k.klageFiledBy) ?? null)
        : k.legalFinalBy
          ? (staffName.get(k.legalFinalBy) ?? null)
          : null,
      verantwortlich: verantwortlichId ? (staffName.get(verantwortlichId) ?? null) : null,
      verantwortlichId,
      href: `/staff/clients/${k.clientId}/notices`,
    });
  }

  for (const r of requests) {
    const verantwortlichId = hauptbearbeiter.get(r.clientId) ?? null;
    eintraege.push({
      quelle: 'ANFORDERUNG',
      id: r.id,
      titel: r.title,
      clientId: r.clientId,
      clientName: r.client.name,
      faelligAm: r.dueAt!,
      erledigt: requestErledigt(r.status),
      erledigtAm: null,
      erledigtVon: null,
      verantwortlich: verantwortlichId ? (staffName.get(verantwortlichId) ?? null) : null,
      verantwortlichId,
      href: `/staff/requests/${r.id}`,
    });
  }

  for (const w of reminders) {
    // Bei mehreren Zustaendigen fuehrt die erste Zuweisung — das Fristenbuch
    // kennt genau eine verantwortliche Person je Eintrag.
    const clientId = w.clientId!;
    const verantwortlichId =
      w.assignees[0]?.staffId ?? hauptbearbeiter.get(clientId) ?? null;
    eintraege.push({
      quelle: 'WIEDERVORLAGE',
      id: w.id,
      titel: w.subject,
      clientId,
      clientName: w.client!.name,
      faelligAm: w.dueDate,
      erledigt: w.doneAt !== null,
      erledigtAm: w.doneAt,
      erledigtVon: w.doneByStaff ? (staffName.get(w.doneByStaff) ?? null) : null,
      verantwortlich: verantwortlichId ? (staffName.get(verantwortlichId) ?? null) : null,
      verantwortlichId,
      href: `/staff/clients/${clientId}`,
    });
  }

  return sortEintraege(eintraege);
}
