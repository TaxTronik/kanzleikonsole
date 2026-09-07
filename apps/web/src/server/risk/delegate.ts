// =============================================================================
// Delegation einer Markierung → interne Wiedervorlage (ClientReminder).
//
// Requirement C: Risk-Layers Aufgaben-Store wird durch TaxTroniks bestehendes
// System ERSETZT. „Recherche delegieren" ist staff-zu-staff (von/an StaffUser) —
// daher eine ClientReminder (assigneeStaffId), NICHT ein mandantengerichteter
// Request (der wäre im Portal sichtbar). Die Wiedervorlage trägt die Kontext-
// Anker (Begriff, Normanker, Analyse-/Markierungs-/Dokument-ID), die Markierung
// verweist via reminderId zurück und bekommt verantwortlichId = „an".
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { canOtherStaffAccessClientTx } from '@/server/auth/rbac';
import { notify } from '@/server/notifications/service';
import { buildDelegationNotes } from './delegate-notes';
import { subsumtionMarkingHref } from './links';
import type { StaffSession } from '@/server/auth/staff';
import { assertReminderActor } from '@/server/reminders/access';
import { persistReminderReferencesTx } from '@/server/reminders/references';

const DEFAULT_DUE_DAYS = 14;

export interface DelegateMarkingInput {
  markingId: string;
  /** „von" — auslösender StaffUser. */
  createdByStaffId: string;
  /** „an" — zuständiger StaffUser. */
  assigneeStaffId: string;
  /** Fälligkeit der Wiedervorlage; Default: +14 Tage. */
  dueDate?: Date;
  /** Freitext-Zusatz, wird unter die Kontext-Anker gehängt. */
  notes?: string;
}

export interface DelegateMarkingResult {
  reminderId: string;
}

export async function delegateMarking(
  ctx: TenantContext,
  input: DelegateMarkingInput,
  session: StaffSession,
): Promise<DelegateMarkingResult> {
  assertReminderActor(session, ctx.tenantId, input.createdByStaffId);
  return withTenantContext(ctx, async (tx) => {
    // Ein Marking darf höchstens eine offene Delegation besitzen. Der
    // transaktionsgebundene Lock schließt auch parallele Doppelklicks, bevor
    // beide Aufrufe jeweils eine Wiedervorlage anlegen könnten.
    const delegationLock = `risk-marking-delegation:${ctx.tenantId}:${input.markingId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${delegationLock}, 0))`;
    const marking = await tx.riskMarking.findUnique({
      where: { id: input.markingId },
      include: {
        analysis: { select: { id: true, clientId: true, documentId: true } },
        reminder: { select: { id: true, doneAt: true } },
      },
    });
    if (!marking) throw new Error('Markierung nicht gefunden.');
    if (marking.reminder && !marking.reminder.doneAt) {
      throw new Error('Für diese Markierung ist bereits eine Delegation offen.');
    }

    const clientId = marking.analysis.clientId;
    if (!clientId) {
      // Eine Wiedervorlage hängt immer an einem Mandanten; eine Analyse ohne
      // Mandantenbezug (z. B. Probe-Text) lässt sich nicht delegieren.
      throw new Error('Delegation erfordert einen Mandantenbezug der Analyse.');
    }

    // „an" MUSS ein aktiver Mitarbeiter DIESES Tenants sein — sonst entstünde eine
    // hängende Zuweisung an eine fremde/ungültige Staff-ID (RLS + expliziter Filter).
    const assignee = await tx.staffUser.findFirst({
      where: { id: input.assigneeStaffId, tenantId: ctx.tenantId, active: true },
      select: { id: true },
    });
    if (!assignee) throw new Error('Zuständige:r Mitarbeiter:in nicht gefunden oder inaktiv.');

    // …und er muss den Mandanten auch sehen dürfen. Vorher wurde das nicht
    // geprüft: bei einem vertraulichen Mandanten liess sich an Unbefugte
    // delegieren, die dann über die Wiedervorlage-Notiz sogar ein wörtliches
    // Zitat aus dem Sachverhalt erhielten.
    if (!(await canOtherStaffAccessClientTx(tx, ctx.tenantId, input.assigneeStaffId, clientId))) {
      throw new Error('Zuständige:r Mitarbeiter:in hat keinen Zugriff auf diesen Mandanten.');
    }

    const dueDate = input.dueDate ?? new Date(Date.now() + DEFAULT_DUE_DAYS * 86_400_000);
    const reminder = await tx.clientReminder.create({
      data: {
        tenantId: ctx.tenantId,
        clientId,
        dueDate,
        subject: `Risiko-Recherche: ${marking.begriff}`,
        notes: buildDelegationNotes(marking, input.notes),
        originRiskMarkingId: marking.id,
        createdByStaff: input.createdByStaffId,
        assignees: { create: { staffId: input.assigneeStaffId } },
      },
      select: { id: true },
    });

    await persistReminderReferencesTx(tx, session, reminder.id, input.notes ?? '');

    await tx.riskMarking.update({
      where: { id: marking.id },
      data: {
        reminderId: reminder.id,
        verantwortlichId: input.assigneeStaffId,
        status: 'IN_PRUEFUNG',
      },
    });

    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: input.createdByStaffId,
      action: 'risk.marking.delegated',
      resourceType: 'risk_marking',
      resourceId: marking.id,
      after: {
        begriff: marking.begriff,
        reminderId: reminder.id,
        assigneeStaffId: input.assigneeStaffId,
        dueDate: dueDate.toISOString(),
        analysisId: marking.analysis.id,
      },
    });

    // Sofort benachrichtigen. Die Wiedervorlage allein meldet sich erst am
    // Fälligkeitstag (Default +14 Tage) über den Tages-Worker — der Empfänger
    // wusste bis dahin nichts von seiner Aufgabe. Der Link springt direkt auf
    // die Markierung, nicht nur auf den Mandanten.
    //
    // Bewusst OHNE `matchedText`: Der Begriff genügt als Betreff, ein wörtliches
    // Zitat aus dem Sachverhalt gehört nicht in eine Benachrichtigungsliste.
    if (input.assigneeStaffId !== input.createdByStaffId) {
      await notify(tx, {
        tenantId: ctx.tenantId,
        staffId: input.assigneeStaffId,
        kind: 'RISK_MARKING_ASSIGNED',
        title: `Recherche zugewiesen: ${marking.begriff}`,
        body:
          marking.normAnker.length > 0
            ? `Normanker: ${marking.normAnker.join(', ')} · fällig ${dueDate.toLocaleDateString('de-DE')}`
            : `Fällig ${dueDate.toLocaleDateString('de-DE')}`,
        href: subsumtionMarkingHref(clientId, marking.analysis.id, marking.id),
        resourceType: 'risk_marking',
        resourceId: marking.id,
      });
    }

    return { reminderId: reminder.id };
  });
}
