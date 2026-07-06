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

import type { TxClient } from '@taxtronik/db';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import type { StaffSession } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import {
  type FristEintrag,
  taxDeadlineErledigt,
  taxNoticeFristErledigt,
  taxNoticeKlageFristErledigt,
  requestErledigt,
  sortEintraege,
} from './eintrag';

const NOTICE_KIND_LABELS: Record<string, string> = {
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
  /** Nur Einträge, für die diese Person verantwortlich ist. */
  nurStaffId?: string | null;
}

export async function loadKontrollbuch(
  tx: TxClient,
  session: StaffSession,
  opts: KontrollbuchOptions,
): Promise<FristEintrag[]> {
  const heute = new Date();
  const horizont = new Date(heute.getTime() + opts.tage * 86400000);
  const rueckschau = new Date(heute.getTime() - opts.tage * 86400000);

  const denied = await inaccessibleClientIdsFor(tx, session);
  const notDenied = denied.length ? { clientId: { notIn: denied } } : {};

  // Offen ohne untere Grenze ODER erledigt im Fenster — je Quelle als OR
  // ausgedrückt, da „erledigt" quellspezifisch ist.
  const [deadlines, notices, klagen, requests, reminders] = await Promise.all([
    tx.taxDeadline.findMany({
      where: {
        ...notDenied,
        OR: [
          { status: { notIn: ['DONE', 'SKIPPED'] }, dueDate: { lte: horizont } },
          { status: { in: ['DONE', 'SKIPPED'] }, dueDate: { gte: rueckschau, lte: horizont } },
        ],
      },
      include: { client: { select: { id: true, name: true } } },
    }),
    tx.taxNotice.findMany({
      where: {
        ...notDenied,
        appealDeadline: { not: null },
        OR: [
          { status: { in: ['NEU', 'GEPRUEFT'] }, appealDeadline: { lte: horizont } },
          {
            status: { in: ['EINSPRUCH', 'ABGEHOLFEN', 'ZURUECKGEWIESEN', 'RECHTSKRAEFTIG'] },
            appealDeadline: { gte: rueckschau, lte: horizont },
          },
        ],
      },
      include: { client: { select: { id: true, name: true } } },
    }),
    // Klagefristen (§ 47 FGO): offen bei ZURUECKGEWIESEN/TEILABHILFE, im
    // Rückschau-Fenster auch KLAGE/RECHTSKRAEFTIG (erledigt).
    tx.taxNotice.findMany({
      where: {
        ...notDenied,
        klageDeadline: { not: null },
        OR: [
          { status: { in: ['ZURUECKGEWIESEN', 'TEILABHILFE'] }, klageDeadline: { lte: horizont } },
          {
            status: { in: ['KLAGE', 'RECHTSKRAEFTIG'] },
            klageDeadline: { gte: rueckschau, lte: horizont },
          },
        ],
      },
      include: { client: { select: { id: true, name: true } } },
    }),
    tx.request.findMany({
      where: {
        ...notDenied,
        dueAt: { not: null },
        OR: [
          { status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] }, dueAt: { lte: horizont } },
          { status: { in: ['CLOSED', 'CANCELLED'] }, dueAt: { gte: rueckschau, lte: horizont } },
        ],
      },
      include: { client: { select: { id: true, name: true } } },
    }),
    tx.clientReminder.findMany({
      where: {
        ...notDenied,
        OR: [
          { doneAt: null, dueDate: { lte: horizont } },
          { doneAt: { not: null }, dueDate: { gte: rueckschau, lte: horizont } },
        ],
      },
      include: { client: { select: { id: true, name: true } } },
    }),
  ]);

  // Verantwortliche: Hauptbearbeiter je Mandant (eine Query) — Wiedervorlagen
  // mit eigener Zuweisung überschreiben das. Namen in einer zweiten Query.
  const clientIds = new Set<string>();
  for (const r of [...deadlines, ...notices, ...klagen, ...requests, ...reminders]) clientIds.add(r.clientId);
  const responsibilities = clientIds.size
    ? await tx.clientResponsibility.findMany({
        where: { clientId: { in: [...clientIds] }, role: 'HAUPTBEARBEITER' },
        select: { clientId: true, staffId: true },
      })
    : [];
  const hauptbearbeiter = new Map(responsibilities.map((r) => [r.clientId, r.staffId]));

  const staffIds = new Set<string>();
  for (const sid of hauptbearbeiter.values()) staffIds.add(sid);
  for (const d of deadlines) if (d.completedByStaff) staffIds.add(d.completedByStaff);
  for (const n of notices) if (n.reviewedBy) staffIds.add(n.reviewedBy);
  for (const k of klagen) if (k.reviewedBy) staffIds.add(k.reviewedBy);
  for (const r of reminders) {
    if (r.assigneeStaffId) staffIds.add(r.assigneeStaffId);
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
      clientId: d.client.id,
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
      titel: `${NOTICE_KIND_LABELS[n.kind] ?? n.kind} ${n.period}`,
      clientId: n.client.id,
      clientName: n.client.name,
      faelligAm: n.appealDeadline!,
      erledigt: taxNoticeFristErledigt(n.status),
      erledigtAm: n.appealFiledAt ?? n.reviewedAt,
      erledigtVon: n.reviewedBy ? (staffName.get(n.reviewedBy) ?? null) : null,
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
      titel: `${NOTICE_KIND_LABELS[k.kind] ?? k.kind} ${k.period} (Klage FG)`,
      clientId: k.client.id,
      clientName: k.client.name,
      faelligAm: k.klageDeadline,
      erledigt: taxNoticeKlageFristErledigt(k.status),
      erledigtAm: k.appealResolvedAt,
      erledigtVon: k.reviewedBy ? (staffName.get(k.reviewedBy) ?? null) : null,
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
      clientId: r.client.id,
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
    const verantwortlichId = w.assigneeStaffId ?? hauptbearbeiter.get(w.clientId) ?? null;
    eintraege.push({
      quelle: 'WIEDERVORLAGE',
      id: w.id,
      titel: w.subject,
      clientId: w.client.id,
      clientName: w.client.name,
      faelligAm: w.dueDate,
      erledigt: w.doneAt !== null,
      erledigtAm: w.doneAt,
      erledigtVon: w.doneByStaff ? (staffName.get(w.doneByStaff) ?? null) : null,
      verantwortlich: verantwortlichId ? (staffName.get(verantwortlichId) ?? null) : null,
      verantwortlichId,
      href: `/staff/clients/${w.clientId}`,
    });
  }

  const gefiltert = opts.nurStaffId
    ? eintraege.filter((e) => e.verantwortlichId === opts.nurStaffId)
    : eintraege;

  return sortEintraege(gefiltert);
}
