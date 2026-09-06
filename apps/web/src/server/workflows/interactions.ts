import type { TxClient } from '@taxtronik/db';
import type { StaffCtx } from '@/server/actions/staff-action';
import { ActionError } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { createWorkflowFeedbackTx, type FeedbackOutcome } from '@taxtronik/db/workflow-feedback';
import { z } from 'zod';

export {
  canInviteFeedback,
  validInteractionResponse,
  FEEDBACK_INTERVAL_DAYS,
} from './interaction-policy';
export const noticeDecisionSnapshot = z.object({
  version: z.literal(1),
  title: z.string(),
  explanation: z.string(),
  noticeUpdatedAt: z.string(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  documentSha256: z.string(),
  assessedAmount: z.string().nullable(),
  appealDeadline: z.string(),
});

// CLIENT-FEEDBACK-001: the client row lock also serializes invitations from different milestones.
export async function createFeedbackInvitationTx(
  tx: TxClient,
  g: StaffCtx,
  instanceId: string,
  contactId: string,
  automatic = false,
): Promise<boolean> {
  const outcome = await createWorkflowFeedbackTx(
    tx,
    {
      tenantId: g.tenantId,
      staffId: g.staffId,
      instanceId,
      contactId,
      automatic,
    },
    async (invitationId) => {
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: 'feedback.invited',
        resourceType: 'client_interaction',
        resourceId: invitationId,
        after: { sourceId: instanceId, automatic },
      });
    },
  );
  if (outcome === 'INVITED') return true;
  if (automatic || outcome === 'DISABLED') return false;
  const messages: Record<Exclude<FeedbackOutcome, 'INVITED'>, string> = {
    DISABLED: 'Feedback ist deaktiviert.',
    NOT_COMPLETED: 'Der Workflow ist noch nicht abgeschlossen.',
    ALREADY_INVITED: 'Bereits angefragt oder Mindestabstand von 90 Tagen noch nicht erreicht.',
    INTERVAL: 'Bereits angefragt oder Mindestabstand von 90 Tagen noch nicht erreicht.',
    CONTACT_UNAVAILABLE: 'Aktiver Kontakt des Mandanten erforderlich.',
    ACTOR_UNAVAILABLE: 'Aktueller Mandantenzugriff erforderlich.',
    CLIENT_INACTIVE: 'Aktives Mandat erforderlich.',
  };
  throw new ActionError(messages[outcome]);
}
