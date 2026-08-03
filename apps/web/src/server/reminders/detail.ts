// =============================================================================
// Eine Wiedervorlage mit allem, was daran hängt: Kette (Vorgänger/Folgestufen),
// Wortmeldungen, Anhänge, Zuständige.
//
// Der Zugriff läuft über `assertReminderAccessTx` — mit Mandant entscheidet die
// Mandanten-Policy, ohne Mandant die Beteiligung an der internen Aufgabe.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { assertReminderAccessTx } from './access';
import { parseDelegationNotes } from '@/server/risk/delegate-notes';
import type { ReminderPriority } from '@/lib/reminder-priority';

export interface ReminderKettenglied {
  id: string;
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
}

export interface ReminderDetail {
  id: string;
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

export async function loadReminderDetail(
  ctx: TenantContext,
  session: StaffSession,
  reminderId: string,
): Promise<ReminderDetail | null> {
  return withTenantContext(ctx, async (tx) => {
    const r = await tx.clientReminder.findUnique({
      where: { id: reminderId },
      select: {
        id: true,
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
        discussion: { orderBy: { createdAt: 'asc' }, take: 200 },
        attachments: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { id: true, title: true, mimeType: true, createdAt: true },
        },
        successors: {
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: { id: true, subject: true, dueDate: true, doneAt: true },
        },
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
      },
    });
    if (!r) return null;
    await assertReminderAccessTx(tx, session, r);

    // Vorgängerkette rückwärts lesen — mit Deckel gegen eine (theoretisch
    // mögliche) Zyklusbildung durch nachträgliches Umhängen.
    const vorgaenger: ReminderKettenglied[] = [];
    const gesehen = new Set<string>([r.id]);
    let cursor = r.predecessorId;
    while (cursor && vorgaenger.length < MAX_KETTE && !gesehen.has(cursor)) {
      gesehen.add(cursor);
      const v = await tx.clientReminder.findUnique({
        where: { id: cursor },
        select: { id: true, subject: true, dueDate: true, doneAt: true, predecessorId: true },
      });
      if (!v) break;
      vorgaenger.unshift({
        id: v.id,
        subject: v.subject,
        dueDate: v.dueDate.toISOString(),
        doneAt: v.doneAt ? v.doneAt.toISOString() : null,
      });
      cursor = v.predecessorId;
    }

    const staffIds = [
      ...new Set([
        r.createdByStaff,
        ...(r.doneByStaff ? [r.doneByStaff] : []),
        ...r.assignees.map((a) => a.staffId),
        ...r.discussion.map((n) => n.staffId),
      ]),
    ];
    const namen = new Map(
      (
        await tx.staffUser.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, fullName: true },
        })
      ).map((s) => [s.id, s.fullName]),
    );

    const marking = r.riskMarkings[0] ?? null;
    const ctxNotes = marking ? parseDelegationNotes(r.notes) : null;

    return {
      id: r.id,
      clientId: r.clientId,
      clientName: r.client?.name ?? null,
      subject: r.subject,
      dueDate: r.dueDate.toISOString(),
      priority: r.priority,
      doneAt: r.doneAt ? r.doneAt.toISOString() : null,
      doneByName: r.doneByStaff ? (namen.get(r.doneByStaff) ?? null) : null,
      createdByStaff: r.createdByStaff,
      createdByName: namen.get(r.createdByStaff) ?? null,
      assignees: r.assignees.map((a) => ({
        staffId: a.staffId,
        fullName: namen.get(a.staffId) ?? 'Unbekannt',
      })),
      begriff: ctxNotes?.begriff ?? null,
      normAnker: ctxNotes?.normAnker ?? [],
      fundstelle: ctxNotes?.fundstelle ?? null,
      auftrag: ctxNotes?.auftrag ?? (marking ? null : r.notes?.trim() || null),
      researchMarkingId: marking?.id ?? null,
      researchAnalysisId: marking?.analysisId ?? null,
      vorgaenger,
      folgestufen: r.successors.map((s) => ({
        id: s.id,
        subject: s.subject,
        dueDate: s.dueDate.toISOString(),
        doneAt: s.doneAt ? s.doneAt.toISOString() : null,
      })),
      discussion: r.discussion.map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
        staffId: n.staffId,
        staffName: namen.get(n.staffId) ?? 'Unbekannt',
      })),
      attachments: r.attachments.map((d) => ({
        id: d.id,
        title: d.title,
        mimeType: d.mimeType,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  });
}
