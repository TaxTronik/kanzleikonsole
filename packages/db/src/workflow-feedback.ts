import type { TxClient } from './tenant-context';
import { readBooleanTenantModules } from './tenant-modules';
import { canStaffAccessClientTx } from './staff-client-access';

// Fachkatalog: CLIENT-FEEDBACK-001, WORKFLOW-LIFECYCLE-001.
export const FEEDBACK_INTERVAL_DAYS = 90;
export function canInviteFeedback(lastInvitation: Date | null, now: Date): boolean {
  return (
    lastInvitation === null ||
    now.getTime() - lastInvitation.getTime() >= FEEDBACK_INTERVAL_DAYS * 86400000
  );
}

export type FeedbackOutcome =
  | 'INVITED'
  | 'DISABLED'
  | 'NOT_COMPLETED'
  | 'ALREADY_INVITED'
  | 'INTERVAL'
  | 'CONTACT_UNAVAILABLE'
  | 'ACTOR_UNAVAILABLE'
  | 'CLIENT_INACTIVE';

/** The caller keeps invitation, processing marker and evidence in one transaction. */
export async function createWorkflowFeedbackTx(
  tx: TxClient,
  input: {
    tenantId: string;
    staffId: string;
    instanceId: string;
    contactId: string;
    automatic: boolean;
    now?: Date;
  },
  record: (invitationId: string) => Promise<void>,
): Promise<FeedbackOutcome> {
  const now = input.now ?? new Date();
  await tx.$queryRaw`SELECT id FROM workflow_instance
    WHERE id=${input.instanceId}::uuid AND tenant_id=${input.tenantId}::uuid FOR UPDATE`;
  const workflow = await tx.workflowInstance.findFirst({
    where: { id: input.instanceId, tenantId: input.tenantId },
  });
  if (!workflow || workflow.status !== 'COMPLETED') return 'NOT_COMPLETED';
  const finish = async (outcome: FeedbackOutcome): Promise<FeedbackOutcome> => {
    if (input.automatic)
      await tx.workflowInstance.update({
        where: { id: workflow.id },
        data: { feedbackProcessedAt: now },
      });
    return outcome;
  };
  if (!(await readBooleanTenantModules(tx, input.tenantId)).feedbackSurveys)
    return finish('DISABLED');
  await tx.$queryRaw`SELECT id FROM client WHERE id=${workflow.clientId}::uuid FOR UPDATE`;
  const client = await tx.client.findFirst({
    where: {
      id: workflow.clientId,
      tenantId: input.tenantId,
      allowActive: true,
      mandateEndedAt: null,
      anonymizedAt: null,
    },
    select: { id: true },
  });
  if (!client) return finish('CLIENT_INACTIVE');
  if (!(await canStaffAccessClientTx(tx, input.tenantId, input.staffId, workflow.clientId)))
    return finish('ACTOR_UNAVAILABLE');
  const duplicate = await tx.clientInteraction.findFirst({
    where: {
      tenantId: input.tenantId,
      sourceId: workflow.id,
      kind: 'FEEDBACK',
    },
  });
  if (duplicate) return finish('ALREADY_INVITED');
  const prior = await tx.clientInteraction.findFirst({
    where: {
      tenantId: input.tenantId,
      clientId: workflow.clientId,
      kind: 'FEEDBACK',
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!canInviteFeedback(prior?.createdAt ?? null, now)) return finish('INTERVAL');
  const contact = await tx.clientContact.findFirst({
    where: {
      id: input.contactId,
      tenantId: input.tenantId,
      clientId: workflow.clientId,
      active: true,
    },
  });
  if (!contact) return finish('CONTACT_UNAVAILABLE');
  const request = await tx.request.create({
    data: {
      tenantId: input.tenantId,
      clientId: workflow.clientId,
      title: 'Freiwillige Rückmeldung an Ihre Kanzlei',
      description:
        'Ihre Rückmeldung ist freiwillig. Es gibt keine automatischen Erinnerungen. Bitte öffnen Sie den Bereich Rückmeldungen im Portal.',
      createdByStaff: input.staffId,
    },
  });
  const invitation = await tx.clientInteraction.create({
    data: {
      tenantId: input.tenantId,
      clientId: workflow.clientId,
      contactId: contact.id,
      kind: 'FEEDBACK',
      sourceId: workflow.id,
      requestId: request.id,
      snapshot: {
        version: 1,
        title: workflow.name,
        completedAt: workflow.completedAt?.toISOString() ?? null,
      },
      expiresAt: new Date(now.getTime() + 30 * 86400000),
      createdByStaff: input.staffId,
    },
  });
  await record(invitation.id);
  return finish('INVITED');
}
