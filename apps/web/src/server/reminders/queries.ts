// =============================================================================
// Wiedervorlagen-Übersicht (/staff/reminders).
//
// Zwei Blickrichtungen auf denselben Datenbestand:
//   „an mich"       — was ICH abzuarbeiten habe (assigneeStaffId = ich)
//   „von mir"       — was ICH delegiert habe und wo es gerade liegt
//                     (createdByStaff = ich, an jemand anderen zugewiesen)
//
// Mandantensichtbarkeit: `inaccessibleClientIdsFor` liefert die IDs, die diese
// Person NICHT sehen darf (vertrauliche Mandate / RESTRICTED-Modus). Eine
// Wiedervorlage zu einem gesperrten Mandanten taucht hier nicht auf — auch
// nicht, wenn sie einem selbst zugewiesen wurde: der Mandantenname und das
// Stichwort sind selbst Inhalt.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import { parseDelegationNotes } from '@/server/risk/delegate-notes';

export type ReminderScope = 'mir' | 'vonmir';

export interface ReminderRow {
  id: string;
  clientId: string;
  clientName: string;
  dueDate: string;
  subject: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  doneAt: string | null;
  assigneeStaffId: string | null;
  assigneeName: string | null;
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
  offen: ReminderRow[];
  erledigt: ReminderRow[];
}

const MAX_ROWS = 200;

export async function loadReminderOverview(
  ctx: TenantContext,
  session: StaffSession,
  scope: ReminderScope,
): Promise<ReminderOverview> {
  const { staffId } = session.user;

  return withTenantContext(ctx, async (tx) => {
    const gesperrt = await inaccessibleClientIdsFor(tx, session);

    const wer =
      scope === 'mir'
        ? { assigneeStaffId: staffId }
        : // „von mir delegiert": nur echte Delegationen, nicht die eigenen Notizen.
          { createdByStaff: staffId, NOT: { assigneeStaffId: staffId } };

    const rows = await tx.clientReminder.findMany({
      where: {
        ...wer,
        ...(gesperrt.length > 0 ? { clientId: { notIn: gesperrt } } : {}),
      },
      orderBy: [{ doneAt: 'asc' }, { dueDate: 'asc' }],
      take: MAX_ROWS,
      select: {
        id: true,
        clientId: true,
        dueDate: true,
        subject: true,
        notes: true,
        priority: true,
        doneAt: true,
        assigneeStaffId: true,
        createdByStaff: true,
        client: { select: { name: true } },
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
      },
    });

    // Namen in EINER Abfrage nachladen (statt Relation pro Zeile — StaffUser
    // hängt nicht als FK an createdByStaff).
    const staffIds = [
      ...new Set(rows.flatMap((r) => [r.createdByStaff, r.assigneeStaffId].filter(Boolean))),
    ] as string[];
    const namen = new Map(
      (
        await tx.staffUser.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, fullName: true },
        })
      ).map((s) => [s.id, s.fullName]),
    );

    const mapped: ReminderRow[] = rows.map((r) => {
      const marking = r.riskMarkings[0] ?? null;
      const ctxNotes = marking ? parseDelegationNotes(r.notes) : null;
      return {
        id: r.id,
        clientId: r.clientId,
        clientName: r.client.name,
        dueDate: r.dueDate.toISOString(),
        subject: r.subject,
        priority: r.priority,
        doneAt: r.doneAt ? r.doneAt.toISOString() : null,
        assigneeStaffId: r.assigneeStaffId,
        assigneeName: r.assigneeStaffId ? (namen.get(r.assigneeStaffId) ?? null) : null,
        createdByStaff: r.createdByStaff,
        createdByName: namen.get(r.createdByStaff) ?? null,
        researchMarkingId: marking?.id ?? null,
        researchAnalysisId: marking?.analysisId ?? null,
        begriff: ctxNotes?.begriff ?? null,
        normAnker: ctxNotes?.normAnker ?? [],
        auftrag: ctxNotes?.auftrag ?? (marking ? null : r.notes?.trim() || null),
      };
    });

    return {
      offen: mapped.filter((r) => !r.doneAt),
      erledigt: mapped.filter((r) => r.doneAt),
    };
  });
}
