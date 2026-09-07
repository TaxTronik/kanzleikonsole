// =============================================================================
// Wiedervorlagen-Übersicht (/staff/reminders).
//
// An mich, von mir oder alle aktuell zugänglichen Tickets. Mandantenpolicy
// und interne Beteiligung begrenzen die Abfrage vor Zählung und Pagination.
// Offene, erledigte und archivierte Tickets werden getrennt geladen.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { accessibleRemindersWhereTx } from './access';
import type { StaffSession } from '@/server/auth/staff';
import { reminderArchiveAvailability, reminderDate, reminderResearchContext } from './presentation';

export type ReminderScope = 'mir' | 'vonmir' | 'alle';
export type ReminderStatus = 'open' | 'done' | 'archived';

export interface ReminderRow {
  id: string;
  ticketNumber: number;
  archivedAt: string | null;
  canArchive: boolean;
  canRestore: boolean;
  /** null = interne Aufgabe ohne Mandantenbezug. */
  clientId: string | null;
  clientName: string;
  dueDate: string;
  subject: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  doneAt: string | null;
  assigneeStaffIds: string[];
  assigneeNames: string[];
  predecessorId: string | null;
  noteCount: number;
  attachmentCount: number;
  successorCount: number;
  createdByStaff: string;
  createdByName: string | null;
  /** Markierung + Analyse, falls Risiko-Recherche-Delegation (→ Deeplink). */
  researchMarkingId: string | null;
  researchAnalysisId: string | null;
  /** Begriff/Normanker aus der Delegations-Notiz — ohne UUID-Ballast. */
  begriff: string | null;
  normAnker: string[];
  /** Freitext-Auftrag der delegierenden Person. */
  auftrag: string | null;
}

export interface ReminderOverview {
  rows: ReminderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReminderOverviewOptions {
  scope: ReminderScope;
  status: ReminderStatus;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function loadReminderOverview(
  ctx: TenantContext,
  session: StaffSession,
  options: ReminderOverviewOptions,
): Promise<ReminderOverview> {
  const { staffId } = session.user;

  return withTenantContext(ctx, async (tx) => {
    const accessible = await accessibleRemindersWhereTx(tx, session);
    const pageSize = Number.isSafeInteger(options.pageSize)
      ? Math.max(1, Math.min(100, options.pageSize!))
      : 25;
    const requestedPage = Number.isSafeInteger(options.page) ? Math.max(1, options.page!) : 1;
    const search = options.q?.trim().slice(0, 200) ?? '';
    const ticketNumber = /^#?[1-9]\d*$/.test(search) ? Number(search.replace(/^#/, '')) : null;
    const wer: PrismaTypes.ClientReminderWhereInput =
      options.scope === 'mir'
        ? { assignees: { some: { staffId } } }
        : options.scope === 'vonmir'
          ? { createdByStaff: staffId }
          : {};
    const state: PrismaTypes.ClientReminderWhereInput =
      options.status === 'archived'
        ? { archivedAt: { not: null } }
        : { archivedAt: null, doneAt: options.status === 'done' ? { not: null } : null };
    const query: PrismaTypes.ClientReminderWhereInput = !search
      ? {}
      : ticketNumber !== null
        ? { ticketNumber: ticketNumber <= 2147483647 ? ticketNumber : -1 }
        : { subject: { contains: search, mode: 'insensitive' } };
    const where = { AND: [accessible, wer, state, query] };
    const total = await tx.clientReminder.count({ where });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));

    const rows = await tx.clientReminder.findMany({
      where,
      orderBy:
        options.status === 'archived'
          ? [{ archivedAt: 'desc' }, { ticketNumber: 'desc' }]
          : options.status === 'done'
            ? [{ doneAt: 'desc' }, { ticketNumber: 'desc' }]
            : [{ priority: 'desc' }, { dueDate: 'asc' }, { ticketNumber: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        ticketNumber: true,
        archivedAt: true,
        clientId: true,
        dueDate: true,
        subject: true,
        notes: true,
        priority: true,
        doneAt: true,
        doneByStaff: true,
        createdByStaff: true,
        predecessorId: true,
        assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        client: { select: { name: true } },
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
        originRiskMarking: { select: { id: true, analysisId: true } },
        _count: {
          select: {
            discussion: true,
            attachments: { where: { deletedAt: null } },
            successors: { where: accessible },
          },
        },
      },
    });

    // Namen in EINER Abfrage nachladen (statt Relation pro Zeile — StaffUser
    // hängt nicht als FK an createdByStaff).
    const staffIds = [
      ...new Set([
        ...rows.map((r) => r.createdByStaff),
        ...rows.flatMap((r) => r.assignees.map((a) => a.staffId)),
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

    const predecessorIds = rows.flatMap((r) => (r.predecessorId ? [r.predecessorId] : []));
    const visiblePredecessors = new Set(
      predecessorIds.length === 0
        ? []
        : (
            await tx.clientReminder.findMany({
              where: { AND: [accessible, { id: { in: predecessorIds } }] },
              select: { id: true },
            })
          ).map((r) => r.id),
    );
    const mapped: ReminderRow[] = rows.map((r) => {
      const context = reminderResearchContext(r);
      return {
        ...reminderArchiveAvailability(session, r),
        id: r.id,
        ticketNumber: r.ticketNumber,
        archivedAt: reminderDate(r.archivedAt),
        clientId: r.clientId,
        clientName: r.client?.name ?? 'Intern (ohne Mandant)',
        dueDate: r.dueDate.toISOString(),
        subject: r.subject,
        priority: r.priority,
        doneAt: reminderDate(r.doneAt),
        assigneeStaffIds: r.assignees.map((a) => a.staffId),
        assigneeNames: r.assignees
          .map((a) => namen.get(a.staffId))
          .filter((n): n is string => Boolean(n)),
        predecessorId:
          r.predecessorId && visiblePredecessors.has(r.predecessorId) ? r.predecessorId : null,
        noteCount: r._count.discussion,
        attachmentCount: r._count.attachments,
        successorCount: r._count.successors,
        createdByStaff: r.createdByStaff,
        createdByName: namen.get(r.createdByStaff) ?? null,
        researchMarkingId: context.originResearchMarkingId,
        researchAnalysisId: context.originResearchAnalysisId,
        begriff: context.begriff,
        normAnker: context.normAnker,
        auftrag: context.auftrag,
      };
    });

    return { rows: mapped, total, page, pageSize };
  });
}
