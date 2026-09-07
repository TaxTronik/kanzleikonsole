// =============================================================================
// Eine Wiedervorlage mit allem, was daran hängt: Kette (Vorgänger/Folgestufen),
// Wortmeldungen, Anhänge, Zuständige.
//
// Die aktuelle Mandanten- oder Beteiligungs-ACL gilt vor jeder Projektion
// des Tickets, seiner Vorgänger, Nachfolger und beider Referenzrichtungen.
// =============================================================================

import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleRemindersWhereTx } from './access';
import { canAccessClientTx, isStaffAdmin } from '@/server/auth/rbac';
import {
  reminderArchiveAvailability,
  reminderDate,
  reminderResearchContext,
  reminderStaffName,
} from './presentation';
import type { ReminderPriority } from '@/lib/reminder-priority';
import { loadReminderHistoryTx, type ReminderHistoryOptions } from './history';

export interface ReminderKettenglied {
  id: string;
  ticketNumber: number;
  archivedAt: string | null;
  subject: string;
  dueDate: string;
  doneAt: string | null;
}

export interface ReminderNoteView {
  id: string;
  body: string;
  createdAt: string;
  staffId: string;
  staffName: string;
}

export interface ReminderAttachmentView {
  id: string;
  title: string;
  mimeType: string;
  createdAt: string;
  uploadedByName: string;
}

export interface ReminderDetail {
  id: string;
  ticketNumber: number;
  archivedAt: string | null;
  canArchive: boolean;
  canRestore: boolean;
  description: string | null;
  commentsPage: number;
  commentsTotal: number;
  commentsPageSize: number;
  attachmentsPage: number;
  attachmentsTotal: number;
  attachmentsPageSize: number;
  originResearchMarkingId: string | null;
  originResearchAnalysisId: string | null;
  phoneNote: { id: string; subject: string; createdAt: string } | null;
  references: Array<{
    id: string;
    ticketNumber: number;
    subject: string;
    doneAt: string | null;
    archivedAt: string | null;
    direction: 'outgoing' | 'incoming';
  }>;
  clientId: string | null;
  clientName: string | null;
  subject: string;
  dueDate: string;
  priority: ReminderPriority;
  doneAt: string | null;
  doneByName: string | null;
  createdByStaff: string;
  createdByName: string | null;
  assignees: Array<{ staffId: string; fullName: string }>;
  /** Auftragstext — bei Risiko-Delegationen zerlegt (ohne UUID-Ballast). */
  begriff: string | null;
  normAnker: string[];
  fundstelle: string | null;
  auftrag: string | null;
  researchMarkingId: string | null;
  researchAnalysisId: string | null;
  /** Vorgänger-Stufen, älteste zuerst. */
  vorgaenger: ReminderKettenglied[];
  /** Direkte Folgestufen (Nachfragen). */
  folgestufen: ReminderKettenglied[];
  discussion: ReminderNoteView[];
  attachments: ReminderAttachmentView[];
}

/** Wie tief die Vorgängerkette rückwärts gelesen wird (Schleifenschutz). */
const MAX_KETTE = 20;

async function readPhoneNoteContextTx(
  tx: TxClient,
  session: StaffSession,
  reminderClientId: string | null,
  phone: {
    id: string;
    tenantId: string;
    clientId: string | null;
    subject: string;
    createdAt: Date;
    takenByStaff: string;
    forwardToStaff: string | null;
  } | null,
): Promise<ReminderDetail['phoneNote']> {
  if (!phone || phone.tenantId !== session.user.tenantId || phone.clientId !== reminderClientId)
    return null;
  const allowed = phone.clientId
    ? await canAccessClientTx(tx, session, phone.clientId)
    : isStaffAdmin(session) ||
      phone.takenByStaff === session.user.staffId ||
      phone.forwardToStaff === session.user.staffId;
  return allowed
    ? { id: phone.id, subject: phone.subject, createdAt: phone.createdAt.toISOString() }
    : null;
}

export async function loadReminderDetail(
  ctx: TenantContext,
  session: StaffSession,
  reminderId: string,
  options: ReminderHistoryOptions = {},
): Promise<ReminderDetail | null> {
  const identity =
    /^[1-9]\d*$/.test(reminderId) && Number(reminderId) <= 2147483647
      ? { ticketNumber: Number(reminderId) }
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reminderId)
        ? { id: reminderId }
        : null;
  if (!identity) return null;
  return withTenantContext(ctx, async (tx) => {
    const accessible = await accessibleRemindersWhereTx(tx, session);
    const r = await tx.clientReminder.findFirst({
      where: { AND: [accessible, identity, { tenantId: ctx.tenantId }] },
      select: {
        id: true,
        ticketNumber: true,
        archivedAt: true,
        clientId: true,
        subject: true,
        notes: true,
        dueDate: true,
        priority: true,
        doneAt: true,
        doneByStaff: true,
        createdByStaff: true,
        predecessorId: true,
        client: { select: { name: true } },
        assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        successors: {
          where: accessible,
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: {
            id: true,
            ticketNumber: true,
            archivedAt: true,
            subject: true,
            dueDate: true,
            doneAt: true,
          },
        },
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
        originRiskMarking: { select: { id: true, analysisId: true } },
        phoneNote: {
          select: {
            id: true,
            tenantId: true,
            clientId: true,
            subject: true,
            createdAt: true,
            takenByStaff: true,
            forwardToStaff: true,
          },
        },
        outgoingReferences: {
          where: { tenantId: ctx.tenantId, targetReminder: { is: accessible } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            targetReminder: {
              select: {
                id: true,
                ticketNumber: true,
                subject: true,
                doneAt: true,
                archivedAt: true,
              },
            },
          },
        },
        incomingReferences: {
          where: { tenantId: ctx.tenantId, sourceReminder: { is: accessible } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            sourceReminder: {
              select: {
                id: true,
                ticketNumber: true,
                subject: true,
                doneAt: true,
                archivedAt: true,
              },
            },
          },
        },
      },
    });
    if (!r) return null;
    const { discussion, attachments, pagination } = await loadReminderHistoryTx(
      tx,
      ctx.tenantId,
      r.id,
      options,
    );

    // Vorgängerkette rückwärts lesen — mit Deckel gegen eine (theoretisch
    // mögliche) Zyklusbildung durch nachträgliches Umhängen.
    const vorgaenger: ReminderKettenglied[] = [];
    const gesehen = new Set<string>([r.id]);
    let cursor = r.predecessorId;
    while (cursor && vorgaenger.length < MAX_KETTE && !gesehen.has(cursor)) {
      gesehen.add(cursor);
      const v = await tx.clientReminder.findFirst({
        where: { AND: [accessible, { id: cursor }] },
        select: {
          id: true,
          ticketNumber: true,
          archivedAt: true,
          subject: true,
          dueDate: true,
          doneAt: true,
          predecessorId: true,
        },
      });
      if (!v) break;
      vorgaenger.unshift({
        id: v.id,
        ticketNumber: v.ticketNumber,
        archivedAt: reminderDate(v.archivedAt),
        subject: v.subject,
        dueDate: v.dueDate.toISOString(),
        doneAt: reminderDate(v.doneAt),
      });
      cursor = v.predecessorId;
    }

    const staffIds = [
      ...new Set([
        r.createdByStaff,
        ...(r.doneByStaff ? [r.doneByStaff] : []),
        ...r.assignees.map((a) => a.staffId),
        ...discussion.map((n) => n.staffId),
        ...attachments.map((d) => d.ownerStaffId).filter((id): id is string => Boolean(id)),
      ]),
    ];
    const namen = new Map(
      (
        await tx.staffUser.findMany({
          where: { tenantId: ctx.tenantId, id: { in: staffIds } },
          select: { id: true, fullName: true },
        })
      ).map((s) => [s.id, s.fullName]),
    );

    const phoneNote = await readPhoneNoteContextTx(tx, session, r.clientId, r.phoneNote);

    return {
      id: r.id,
      ticketNumber: r.ticketNumber,
      archivedAt: reminderDate(r.archivedAt),
      ...reminderArchiveAvailability(session, r),
      ...reminderResearchContext(r),
      ...pagination,
      phoneNote,
      references: [
        ...r.outgoingReferences.map(({ targetReminder: target }) => ({
          ...target,
          direction: 'outgoing' as const,
        })),
        ...r.incomingReferences.map(({ sourceReminder: source }) => ({
          ...source,
          direction: 'incoming' as const,
        })),
      ].map((reference) => ({
        ...reference,
        doneAt: reminderDate(reference.doneAt),
        archivedAt: reminderDate(reference.archivedAt),
      })),
      clientId: r.clientId,
      clientName: r.client?.name ?? null,
      subject: r.subject,
      dueDate: r.dueDate.toISOString(),
      priority: r.priority,
      doneAt: reminderDate(r.doneAt),
      doneByName: reminderStaffName(namen, r.doneByStaff),
      createdByStaff: r.createdByStaff,
      createdByName: namen.get(r.createdByStaff) ?? null,
      assignees: r.assignees.map((a) => ({
        staffId: a.staffId,
        fullName: namen.get(a.staffId) ?? 'Unbekannt',
      })),
      vorgaenger,
      folgestufen: r.successors.map((s) => ({
        id: s.id,
        ticketNumber: s.ticketNumber,
        archivedAt: reminderDate(s.archivedAt),
        subject: s.subject,
        dueDate: s.dueDate.toISOString(),
        doneAt: reminderDate(s.doneAt),
      })),
      discussion: discussion.map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
        staffId: n.staffId,
        staffName: namen.get(n.staffId) ?? 'Unbekannt',
      })),
      attachments: attachments.map((d) => ({
        id: d.id,
        title: d.title,
        mimeType: d.mimeType,
        createdAt: d.createdAt.toISOString(),
        uploadedByName: reminderStaffName(namen, d.ownerStaffId) ?? 'Unbekannt',
      })),
    };
  });
}
