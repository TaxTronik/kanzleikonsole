// =============================================================================
// Fristenkontrollbuch — Loader.
//
// Aggregiert die fünf fristenführenden Quellen (Steuertermine, Bescheidprüf-
// fälle/Einspruchsfristen, Klagefristen, Anforderungen, Wiedervorlagen) zu
// einer Kontrollsicht. Eigener Zustand entsteht hier NICHT (siehe eintrag.ts)
// — Erledigung wird aus den Quellmodulen abgelesen, wo sie auditiert geführt
// wird.
//
// Fensterlogik: OFFENE Fristen erscheinen bis zum Horizont (heute + tage)
// OHNE untere Grenze — eine überfällige Frist verschwindet nie durch
// Zeitablauf. ERLEDIGTE erscheinen nur im Fenster [heute − tage, Horizont]
// (Kontrollsicht der jüngeren Vergangenheit). Der CSV-Export ist ein
// auditierter Kontrollauszug, aber kein Nachweis der fristwahrenden Handlung.
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
  filingWithinDeadline,
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
  /** Modulquellen; Kern-Anforderungen bleiben unabhängig davon aktiv. */
  sources?: {
    taxNotices: boolean;
    reminders: boolean;
  };
  /** Festgehaltener fachlicher Stichtag, z. B. aus der DB-Uhr des Tagesabschlusses. */
  referenceDate?: Date;
}

function queryWhenEnabled<T>(enabled: boolean, query: () => Promise<T[]>): Promise<T[]> {
  return enabled ? query() : Promise.resolve([]);
}

export async function loadKontrollbuch(
  tx: TxClient,
  session: StaffSession,
  opts: KontrollbuchOptions,
): Promise<FristEintrag[]> {
  const heute = opts.referenceDate ?? berlinTodayUtcMidnight();
  const horizont = new Date(heute.getTime() + opts.tage * 86400000);
  const rueckschau = new Date(heute.getTime() - opts.tage * 86400000);
  const sources = { taxNotices: true, reminders: true, ...opts.sources };

  const denied = await inaccessibleClientIdsFor(tx, session);
  const notDenied = denied.length ? { clientId: { notIn: denied } } : {};
  const responsibleClient: Prisma.ClientWhereInput | undefined = opts.nurStaffId
    ? {
        responsibilities: {
          some: { role: 'HAUPTBEARBEITER', staffId: opts.nurStaffId },
        },
      }
    : undefined;

  // Prisma kann zwei Spalten in einem normalen Where-Objekt nicht portabel
  // gegeneinander vergleichen. Die tenant-/RLS-gebundenen Vorabfragen liefern
  // deshalb nur die IDs tatsächlich nach Fristende dokumentierter Einlegungen.
  // Diese Vorgänge müssen im Kontrollbuch offen bleiben, bis eine fachliche
  // Wiedereinsetzungs-/Dispositionsentscheidung dokumentiert ist.
  const [lateAppealRows, lateKlageRows] = await Promise.all([
    queryWhenEnabled(
      sources.taxNotices,
      () =>
        tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM public."tax_notice"
         WHERE "appeal_deadline" IS NOT NULL
           AND "appeal_deadline" <= ${horizont}
           AND "appeal_filed_at" IS NOT NULL
           AND ("appeal_filed_at" AT TIME ZONE 'UTC')::date > "appeal_deadline"
      `,
    ),
    queryWhenEnabled(
      sources.taxNotices,
      () =>
        tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM public."tax_notice"
         WHERE "klage_deadline" IS NOT NULL
           AND "klage_deadline" <= ${horizont}
           AND "klage_filed_at" IS NOT NULL
           AND ("klage_filed_at" AT TIME ZONE 'UTC')::date > "klage_deadline"
      `,
    ),
  ]);
  const lateAppealIds = lateAppealRows.map((row) => row.id);
  const lateKlageIds = lateKlageRows.map((row) => row.id);

  const deadlineOpen: Prisma.TaxDeadlineWhereInput = {
    dueDate: { lte: horizont },
    OR: [
      { status: { not: 'DONE' } },
      { status: 'DONE', completedAt: null },
      { status: 'DONE', completedByStaff: null },
    ],
  };
  const deadlineClosed: Prisma.TaxDeadlineWhereInput = {
    status: 'DONE',
    completedAt: { not: null },
    completedByStaff: { not: null },
    dueDate: { gte: rueckschau, lte: horizont },
  };
  const deadlineWindow: Prisma.TaxDeadlineWhereInput = opts.nurOffene
    ? deadlineOpen
    : {
        OR: [deadlineOpen, deadlineClosed],
      };
  const appealFilingMissing: Prisma.TaxNoticeWhereInput = {
    OR: [{ appealFiledAt: null }, { appealFiledBy: null }],
  };
  const appealFilingMissingOrLate: Prisma.TaxNoticeWhereInput = lateAppealIds.length
    ? { OR: [appealFilingMissing, { id: { in: lateAppealIds } }] }
    : appealFilingMissing;
  const appealDispositionMissing: Prisma.TaxNoticeWhereInput = {
    OR: [
      { status: { not: 'BESTANDSKRAEFTIG' } },
      { legalFinalAt: null },
      { legalFinalBy: null },
      { legalFinalReason: null },
    ],
  };
  const noticeOpen: Prisma.TaxNoticeWhereInput = {
    appealDeadline: { lte: horizont },
    AND: [appealFilingMissingOrLate, appealDispositionMissing],
  };
  const timelyAppealFiling: Prisma.TaxNoticeWhereInput = {
    appealFiledAt: { not: null },
    appealFiledBy: { not: null },
    ...(lateAppealIds.length ? { id: { notIn: lateAppealIds } } : {}),
  };
  const noticeClosed: Prisma.TaxNoticeWhereInput = {
    appealDeadline: { gte: rueckschau, lte: horizont },
    OR: [
      timelyAppealFiling,
      {
        status: 'BESTANDSKRAEFTIG',
        legalFinalAt: { not: null },
        legalFinalBy: { not: null },
        legalFinalReason: { not: null },
      },
    ],
  };
  const noticeWindow: Prisma.TaxNoticeWhereInput = opts.nurOffene
    ? noticeOpen
    : {
        OR: [noticeOpen, noticeClosed],
      };
  // TAX-NOTICE-APPEAL-001 / TAX-CONTROL-STATUS-001: Wenn die
  // Bekanntgabe-/Fristgrundlage keine belastbare Rechtsbehelfsfrist erlaubt,
  // darf ein gespeicherter interner Risikotermin nicht aus der Kontrolle
  // verschwinden. Er ist ausdrücklich KEINE Einspruchsfrist und bleibt bis zu
  // einer echten Frist offen. Das Produkt besitzt hierfür noch keinen eigenen
  // strukturierten Abschlussgrund; ein generischer BESTANDSKRAEFTIG-Satz darf
  // deshalb auch bei Legacy-/Importdaten nicht als Erledigung fehlgedeutet
  // werden.
  const noticeRiskWindow: Prisma.TaxNoticeWhereInput = {
    appealDeadline: null,
    internalRiskDeadline: { lte: horizont },
    deadlineCalculationStatus: { in: ['MANUAL_REVIEW', 'RISK_ONLY'] },
  };
  const klageFilingMissing: Prisma.TaxNoticeWhereInput = {
    OR: [{ klageFiledAt: null }, { klageFiledBy: null }],
  };
  const klageFilingMissingOrLate: Prisma.TaxNoticeWhereInput = lateKlageIds.length
    ? { OR: [klageFilingMissing, { id: { in: lateKlageIds } }] }
    : klageFilingMissing;
  const klageDispositionMissing: Prisma.TaxNoticeWhereInput = {
    OR: [
      { status: { not: 'BESTANDSKRAEFTIG' } },
      { legalFinalAt: null },
      { legalFinalBy: null },
      { legalFinalReason: null },
    ],
  };
  const klageOpen: Prisma.TaxNoticeWhereInput = {
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
    klageDeadline: { lte: horizont },
    AND: [klageFilingMissingOrLate, klageDispositionMissing],
  };
  const timelyKlageFiling: Prisma.TaxNoticeWhereInput = {
    klageFiledAt: { not: null },
    klageFiledBy: { not: null },
    ...(lateKlageIds.length ? { id: { notIn: lateKlageIds } } : {}),
  };
  const klageClosed: Prisma.TaxNoticeWhereInput = {
    klageDeadline: { gte: rueckschau, lte: horizont },
    OR: [
      timelyKlageFiling,
      {
        status: 'BESTANDSKRAEFTIG',
        legalFinalAt: { not: null },
        legalFinalBy: { not: null },
        legalFinalReason: { not: null },
      },
    ],
  };
  const klageWindow: Prisma.TaxNoticeWhereInput = opts.nurOffene
    ? klageOpen
    : {
        OR: [klageOpen, klageClosed],
      };
  const requestOpen: Prisma.RequestWhereInput = {
    dueAt: { lte: horizont },
    OR: [
      { status: { not: 'CLOSED' } },
      { status: 'CLOSED', closedAt: null },
      { status: 'CLOSED', closedByStaff: null },
    ],
  };
  const requestClosed: Prisma.RequestWhereInput = {
    status: 'CLOSED',
    closedAt: { not: null },
    closedByStaff: { not: null },
    dueAt: { gte: rueckschau, lte: horizont },
  };
  const requestWindow: Prisma.RequestWhereInput = opts.nurOffene
    ? requestOpen
    : {
        OR: [requestOpen, requestClosed],
      };
  const reminderOpen: Prisma.ClientReminderWhereInput = {
    dueDate: { lte: horizont },
    OR: [{ doneAt: null }, { doneByStaff: null }],
  };
  const reminderClosed: Prisma.ClientReminderWhereInput = {
    doneAt: { not: null },
    doneByStaff: { not: null },
    dueDate: { gte: rueckschau, lte: horizont },
  };
  const reminderWindow: Prisma.ClientReminderWhereInput = opts.nurOffene
    ? reminderOpen
    : {
        OR: [reminderOpen, reminderClosed],
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
  const [deadlines, notices, klagen, riskNotices, requests, reminders] = await Promise.all([
    queryWhenEnabled(sources.taxNotices, () =>
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
    ),
    queryWhenEnabled(sources.taxNotices, () =>
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
        },
      }),
    ),
    // TAX-CONTROL-STATUS-001: Klagefristen sind erst nach einer
    // Einspruchs- oder Teil-Einspruchsentscheidung offen, nicht bereits bei
    // TEILABHILFE. Im Rückschau-Fenster auch nachgewiesene Abschlüsse.
    queryWhenEnabled(sources.taxNotices, () =>
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
          manualReviewRequired: true,
          status: true,
          appealResolvedAt: true,
          klageFiledAt: true,
          klageFiledBy: true,
          legalFinalAt: true,
          legalFinalBy: true,
          legalFinalReason: true,
          client: { select: { name: true } },
        },
      }),
    ),
    queryWhenEnabled(sources.taxNotices, () =>
      tx.taxNotice.findMany({
        where: {
          ...notDenied,
          ...noticeRiskWindow,
          ...(responsibleClient ? { client: responsibleClient } : {}),
        },
        select: {
          id: true,
          clientId: true,
          kind: true,
          period: true,
          internalRiskDeadline: true,
          deadlineCalculationStatus: true,
          client: { select: { name: true } },
        },
      }),
    ),
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
        closedAt: true,
        closedByStaff: true,
        client: { select: { name: true } },
      },
    }),
    queryWhenEnabled(sources.reminders, () =>
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
    ),
  ]);

  // Verantwortliche: Hauptbearbeiter je Mandant (eine Query) — Wiedervorlagen
  // mit eigener Zuweisung überschreiben das. Namen in einer zweiten Query.
  const clientIds = new Set<string>();
  for (const r of [...deadlines, ...notices, ...klagen, ...riskNotices, ...requests, ...reminders])
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
  for (const r of requests) if (r.closedByStaff) staffIds.add(r.closedByStaff);
  const staff = staffIds.size
    ? await tx.staffUser.findMany({
        where: { id: { in: [...staffIds] } },
        select: { id: true, fullName: true },
      })
    : [];
  const staffName = new Map(staff.map((s) => [s.id, s.fullName]));

  const eintraege: FristEintrag[] = [];

  type NoticeRow = (typeof notices)[number];
  type KlageRow = (typeof klagen)[number];

  function personName(staffId: string | null): string | null {
    return staffId ? (staffName.get(staffId) ?? null) : null;
  }

  function verantwortung(clientId: string): { id: string | null; name: string | null } {
    const id = hauptbearbeiter.get(clientId) ?? null;
    return { id, name: personName(id) };
  }

  function noticeFilingOutcome(n: NoticeRow) {
    const filingTimely = filingWithinDeadline(n.appealFiledAt, n.appealFiledBy, n.appealDeadline);
    return {
      filingTimely,
      filingLate: Boolean(n.appealFiledAt && n.appealFiledBy && !filingTimely),
      disposition:
        !filingTimely &&
        n.status === 'BESTANDSKRAEFTIG' &&
        Boolean(n.legalFinalAt && n.legalFinalBy && n.legalFinalReason?.trim()),
    };
  }

  function noticeControlHint(
    n: NoticeRow,
    erledigt: boolean,
    filingLate: boolean,
    disposition: boolean,
  ): string | null {
    if (filingLate && !disposition) {
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

  function klageFilingOutcome(k: KlageRow) {
    const filingTimely = filingWithinDeadline(k.klageFiledAt, k.klageFiledBy, k.klageDeadline);
    return {
      filingTimely,
      filingLate: Boolean(k.klageFiledAt && k.klageFiledBy && !filingTimely),
      disposition:
        !filingTimely &&
        k.status === 'BESTANDSKRAEFTIG' &&
        Boolean(k.legalFinalAt && k.legalFinalBy && k.legalFinalReason?.trim()),
    };
  }

  function klageControlHint(
    k: KlageRow,
    erledigt: boolean,
    filingLate: boolean,
    disposition: boolean,
  ): string | null {
    if (filingLate && !disposition) {
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

  function appendTaxDeadlineEntries(): void {
    for (const d of deadlines) {
      const verantwortlich = verantwortung(d.clientId);
      const erledigt = taxDeadlineErledigt(d.status, d.completedAt, d.completedByStaff);
      eintraege.push({
        quelle: 'STEUERTERMIN',
        kontrollart: 'OPERATIONAL_DUE_DATE',
        id: d.id,
        titel: `${SCHEDULE_LABELS[d.kind] ?? d.kind} ${d.period}`,
        clientId: d.clientId,
        clientName: d.client.name,
        faelligAm: d.dueDate,
        erledigt,
        kontrollzustand: erledigt ? 'CLOSED_FULFILLED' : 'OPEN',
        kontrollhinweis:
          d.status === 'SKIPPED'
            ? 'Übersprungen ohne strukturierten Grund und fachliche Freigabe.'
            : d.status === 'DONE' && !erledigt
              ? 'Erledigungszeit oder handelnde Person fehlt.'
              : null,
        erledigtAm: d.completedAt,
        erledigtVon: personName(d.completedByStaff),
        verantwortlich: verantwortlich.name,
        verantwortlichId: verantwortlich.id,
        href: `/staff/tax-deadlines/group?kind=${d.kind}&period=${encodeURIComponent(d.period)}&scope=all`,
      });
    }
  }

  function appendNoticeEntries(): void {
    for (const n of notices) {
      const verantwortlich = verantwortung(n.clientId);
      const erledigt = taxNoticeFristErledigt(n.status, n);
      const { filingTimely, filingLate, disposition } = noticeFilingOutcome(n);
      eintraege.push({
        quelle: 'EINSPRUCHSFRIST',
        kontrollart: n.manualReviewRequired
          ? 'REVIEW_PENDING_CONTROL_PROPOSAL'
          : 'CALCULATED_CONTROL_PROPOSAL',
        id: n.id,
        titel: `${KONTROLLBUCH_NOTICE_KIND_LABELS[n.kind] ?? n.kind} ${n.period}`,
        clientId: n.clientId,
        clientName: n.client.name,
        faelligAm: n.appealDeadline!,
        erledigt,
        kontrollzustand: disposition
          ? 'CLOSED_DISPOSITION'
          : erledigt
            ? 'CLOSED_FULFILLED'
            : 'OPEN',
        kontrollhinweis: noticeControlHint(n, erledigt, filingLate, disposition),
        erledigtAm: filingTimely ? n.appealFiledAt : disposition ? n.legalFinalAt : null,
        erledigtVon: filingTimely
          ? personName(n.appealFiledBy)
          : disposition
            ? personName(n.legalFinalBy)
            : null,
        verantwortlich: verantwortlich.name,
        verantwortlichId: verantwortlich.id,
        href: `/staff/clients/${n.clientId}/notices`,
      });
    }
  }

  function appendRiskNoticeEntries(): void {
    for (const n of riskNotices) {
      if (!n.internalRiskDeadline) continue;
      const verantwortlich = verantwortung(n.clientId);
      const noticeTitle = `${KONTROLLBUCH_NOTICE_KIND_LABELS[n.kind] ?? n.kind} ${n.period}`;
      eintraege.push({
        // Technisch dieselbe Bescheidquelle, aber mit eigener Anzeigeart: weder
        // UI noch CSV dürfen aus dem Risikotermin eine Einspruchsfrist machen.
        quelle: 'EINSPRUCHSFRIST',
        kontrollart: 'INTERNAL_RISK',
        artLabel: 'Interner Prüftermin',
        id: n.id,
        titel: `Interner Prüftermin: ${noticeTitle} (keine Rechtsbehelfsfrist)`,
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
      });
    }
  }

  function appendKlageEntries(): void {
    for (const k of klagen) {
      if (!k.klageDeadline) continue;
      const verantwortlich = verantwortung(k.clientId);
      const erledigt = taxNoticeKlageFristErledigt(k.status, k);
      const { filingTimely, filingLate, disposition } = klageFilingOutcome(k);
      eintraege.push({
        quelle: 'KLAGEFRIST',
        kontrollart: k.manualReviewRequired
          ? 'REVIEW_PENDING_CONTROL_PROPOSAL'
          : 'CALCULATED_CONTROL_PROPOSAL',
        id: k.id,
        titel: `${KONTROLLBUCH_NOTICE_KIND_LABELS[k.kind] ?? k.kind} ${k.period} (Klage FG)`,
        clientId: k.clientId,
        clientName: k.client.name,
        faelligAm: k.klageDeadline,
        erledigt,
        kontrollzustand: disposition
          ? 'CLOSED_DISPOSITION'
          : erledigt
            ? 'CLOSED_FULFILLED'
            : 'OPEN',
        kontrollhinweis: klageControlHint(k, erledigt, filingLate, disposition),
        // #11: Erledigung = tatsächliche Klageeinreichung (wer/wann), nicht die
        // Einspruchsentscheidung (= Fristbeginn) bzw. der Bescheidprüfer. Fallback
        // auf Abschluss-/Entscheidungsdaten nur für Altbestand ohne die
        // belastbaren klageFiled*-Felder.
        erledigtAm: filingTimely ? k.klageFiledAt : disposition ? k.legalFinalAt : null,
        erledigtVon: filingTimely
          ? personName(k.klageFiledBy)
          : disposition
            ? personName(k.legalFinalBy)
            : null,
        verantwortlich: verantwortlich.name,
        verantwortlichId: verantwortlich.id,
        href: `/staff/clients/${k.clientId}/notices`,
      });
    }
  }

  function appendRequestEntries(): void {
    for (const r of requests) {
      const verantwortlich = verantwortung(r.clientId);
      const erledigt = requestErledigt(r.status, r.closedAt, r.closedByStaff);
      eintraege.push({
        quelle: 'ANFORDERUNG',
        kontrollart: 'OPERATIONAL_DUE_DATE',
        id: r.id,
        titel: r.title,
        clientId: r.clientId,
        clientName: r.client.name,
        faelligAm: r.dueAt!,
        erledigt,
        kontrollzustand: erledigt ? 'CLOSED_FULFILLED' : 'OPEN',
        kontrollhinweis:
          r.status === 'CANCELLED'
            ? 'Storniert ohne strukturierten Abschlussgrund.'
            : r.status === 'CLOSED' && !erledigt
              ? 'Abschlusszeit oder handelnde Person fehlt.'
              : null,
        erledigtAm: erledigt ? r.closedAt : null,
        erledigtVon: erledigt ? personName(r.closedByStaff) : null,
        verantwortlich: verantwortlich.name,
        verantwortlichId: verantwortlich.id,
        href: `/staff/requests/${r.id}`,
      });
    }
  }

  function appendReminderEntries(): void {
    for (const w of reminders) {
      // Bei mehreren Zustaendigen fuehrt die erste Zuweisung — das Fristenbuch
      // kennt genau eine verantwortliche Person je Eintrag.
      const clientId = w.clientId!;
      const verantwortlichId = w.assignees[0]?.staffId ?? hauptbearbeiter.get(clientId) ?? null;
      const erledigt = Boolean(w.doneAt && w.doneByStaff);
      eintraege.push({
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
        erledigtVon: personName(w.doneByStaff),
        verantwortlich: personName(verantwortlichId),
        verantwortlichId,
        href: `/staff/clients/${clientId}`,
      });
    }
  }

  appendTaxDeadlineEntries();
  appendNoticeEntries();
  appendRiskNoticeEntries();
  appendKlageEntries();
  appendRequestEntries();
  appendReminderEntries();

  return sortEintraege(eintraege);
}
