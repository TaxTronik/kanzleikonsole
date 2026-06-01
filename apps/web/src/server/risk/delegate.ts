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
import { buildDelegationNotes } from './delegate-notes';

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
): Promise<DelegateMarkingResult> {
  return withTenantContext(ctx, async (tx) => {
    const marking = await tx.riskMarking.findUnique({
      where: { id: input.markingId },
      include: { analysis: { select: { id: true, clientId: true, documentId: true } } },
    });
    if (!marking) throw new Error('Markierung nicht gefunden.');

    const clientId = marking.analysis.clientId;
    if (!clientId) {
      // Eine Wiedervorlage hängt immer an einem Mandanten; eine Analyse ohne
      // Mandantenbezug (z. B. Probe-Text) lässt sich nicht delegieren.
      throw new Error('Delegation erfordert einen Mandantenbezug der Analyse.');
    }

    const dueDate = input.dueDate ?? new Date(Date.now() + DEFAULT_DUE_DAYS * 86_400_000);
    const reminder = await tx.clientReminder.create({
      data: {
        tenantId: ctx.tenantId,
        clientId,
        dueDate,
        subject: `Risiko-Recherche: ${marking.begriff}`,
        notes: buildDelegationNotes(marking, input.notes),
        createdByStaff: input.createdByStaffId,
        assigneeStaffId: input.assigneeStaffId,
      },
      select: { id: true },
    });

    await tx.riskMarking.update({
      where: { id: marking.id },
      data: {
        reminderId: reminder.id,
        verantwortlichId: input.assigneeStaffId,
        status: 'IN_PRUEFUNG',
      },
    });

    return { reminderId: reminder.id };
  });
}
