'use server';
import { z } from 'zod';
import { lockWorkflowInstanceTx } from '@taxtronik/db/workflow-lifecycle';
import { withStaff, ActionError } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { assertModuleEnabled } from '@/server/settings/modules';
import { evidenceService } from '@/server/container';
import {
  createFeedbackInvitationTx,
  noticeDecisionSnapshot,
} from '@/server/workflows/interactions';
import { berlinWallClockToUtc } from '@/lib/fmt';
import { validWorkflowCalendarDate } from '@/server/workflows/interaction-policy';

type NoticeDeadlineState = {
  status: string;
  deadlineCalculationStatus: string;
  manualReviewRequired: boolean;
  appealDeadline: Date | null;
};

function noticeHasReviewableDeadline(
  notice: NoticeDeadlineState,
): notice is NoticeDeadlineState & { appealDeadline: Date } {
  return (
    notice.status === 'GEPRUEFT' &&
    notice.deadlineCalculationStatus === 'CALCULATED' &&
    !notice.manualReviewRequired &&
    Boolean(notice.appealDeadline)
  );
}

type NoticeDocumentForInvitation = {
  id: string;
  deletedAt: Date | null;
  sharedWithClientAt: Date | null;
  versions: Array<{ id: string; scanStatus: string; sha256: Uint8Array<ArrayBufferLike> }>;
};

function portalReadyNoticeDocument(document: NoticeDocumentForInvitation | null): {
  document: NoticeDocumentForInvitation;
  version: NoticeDocumentForInvitation['versions'][number];
} {
  const version = document?.versions[0];
  if (
    !document ||
    document.deletedAt ||
    !document.sharedWithClientAt ||
    version?.scanStatus !== 'CLEAN'
  )
    throw new ActionError('Bescheiddokument zuerst ausdrücklich für das Portal freigeben.');
  return { document, version };
}

function responseDeadlineIsAllowed(
  expiresAt: Date | null,
  deadlineEnd: Date | null,
  now: Date,
): expiresAt is Date {
  return Boolean(expiresAt && expiresAt > now && deadlineEnd && expiresAt <= deadlineEnd);
}

export async function inviteNoticeDecisionAction(data: FormData) {
  const parsed = z
    .object({
      noticeId: z.string().uuid(),
      contactId: z.string().uuid(),
      explanation: z.string().trim().min(10).max(5000),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/)
        .refine((value) => validWorkflowCalendarDate(value.slice(0, 10))),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success)
    return { ok: false, error: 'Bescheid, Kontakt, Erläuterung und Antworttermin prüfen.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'taxNotices');
      await tx.$queryRaw`SELECT id FROM tax_notice WHERE id=${parsed.data.noticeId}::uuid FOR UPDATE`;
      const notice = await tx.taxNotice.findUnique({
        where: { id: parsed.data.noticeId },
        include: {
          document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } },
        },
      });
      if (!notice) throw new ActionError('Bescheid nicht gefunden.');
      await assertClientAccessTx(tx, g.session, notice.clientId);
      if (!noticeHasReviewableDeadline(notice))
        throw new ActionError('Geprüfter Bescheid mit geklärtem Fristvorschlag erforderlich.');
      const { document, version } = portalReadyNoticeDocument(notice.document);
      const expiresAt = berlinWallClockToUtc(parsed.data.due);
      const deadlineEnd = berlinWallClockToUtc(
        `${notice.appealDeadline.toISOString().slice(0, 10)}T23:59`,
      );
      if (!responseDeadlineIsAllowed(expiresAt, deadlineEnd, new Date()))
        throw new ActionError(
          'Antworttermin muss in der Zukunft und spätestens am Fristende liegen.',
        );
      const contact = await tx.clientContact.findFirst({
        where: { id: parsed.data.contactId, clientId: notice.clientId, active: true },
      });
      if (!contact) throw new ActionError('Aktiver Kontakt dieses Mandanten erforderlich.');
      const previous = await tx.clientInteraction.findFirst({
        where: { kind: 'NOTICE', sourceId: notice.id },
        orderBy: { revision: 'desc' },
      });
      if (previous?.status === 'OPEN')
        throw new ActionError('Es besteht bereits eine offene Anfrage. Diese zuerst zurückziehen.');
      const request = await tx.request.create({
        data: {
          tenantId: g.tenantId,
          clientId: notice.clientId,
          title: 'Rückmeldung zu einem geprüften Bescheid',
          description:
            'Die Kanzlei hat eine Entscheidung angefragt. Nur der ausgewählte Kontakt kann im Portalbereich Rückmeldungen antworten. Die Anfrage ersetzt keine Fristenkontrolle.',
          createdByStaff: g.staffId,
        },
      });
      const snapshot = noticeDecisionSnapshot.parse({
        version: 1,
        title: `Bescheid ${notice.kind} ${notice.period}`,
        explanation: parsed.data.explanation,
        noticeUpdatedAt: notice.updatedAt.toISOString(),
        documentId: document.id,
        documentVersionId: version.id,
        documentSha256: Buffer.from(version.sha256).toString('hex'),
        assessedAmount: notice.assessedAmount?.toString() ?? null,
        appealDeadline: notice.appealDeadline.toISOString(),
      });
      const invitation = await tx.clientInteraction.create({
        data: {
          tenantId: g.tenantId,
          clientId: notice.clientId,
          contactId: contact.id,
          kind: 'NOTICE',
          revision: (previous?.revision ?? 0) + 1,
          sourceId: notice.id,
          requestId: request.id,
          snapshot,
          expiresAt,
          createdByStaff: g.staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorId: g.staffId,
        actorType: 'STAFF',
        action: 'notice.decision.invited',
        resourceType: 'client_interaction',
        resourceId: invitation.id,
        after: {
          noticeId: notice.id,
          documentVersionId: version.id,
          revision: invitation.revision,
        },
      });
    },
    { module: 'noticeDecisions', revalidate: '/staff/interactions' },
  );
}

export async function configureFeedbackAction(data: FormData) {
  const parsed = z
    .object({ instanceId: z.string().uuid(), contactId: z.string().uuid() })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { ok: false, error: 'Workflow und Kontakt auswählen.' };
  return withStaff(
    async (tx, g) => {
      await assertModuleEnabled(g.ctx, 'workflows');
      // CLIENT-FEEDBACK-001 / WORKFLOW-LIFECYCLE-001: Auswahl und Abschluss
      // teilen denselben Parent-Lock. Ein bereits parallel erfolgter Abschluss
      // muss vor der Entscheidung zwischen Vormerkung und Einladung sichtbar sein.
      await lockWorkflowInstanceTx(tx, parsed.data.instanceId);
      const workflow = await tx.workflowInstance.findUnique({
        where: { id: parsed.data.instanceId },
      });
      if (!workflow) throw new ActionError('Workflow nicht gefunden.');
      await assertClientAccessTx(tx, g.session, workflow.clientId);
      const contact = await tx.clientContact.findFirst({
        where: { id: parsed.data.contactId, clientId: workflow.clientId, active: true },
      });
      if (!contact) throw new ActionError('Kontakt gehört nicht zum Mandanten.');
      if (workflow.status === 'COMPLETED')
        await createFeedbackInvitationTx(tx, g, workflow.id, contact.id);
      else if (workflow.status === 'ACTIVE' || workflow.status === 'PAUSED')
        await tx.workflowInstance.update({
          where: { id: workflow.id },
          data: { feedbackContactId: contact.id },
        });
      else throw new ActionError('Abgebrochene Workflows können kein Feedback auslösen.');
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorId: g.staffId,
        actorType: 'STAFF',
        action: 'feedback.configured',
        resourceType: 'workflow_instance',
        resourceId: workflow.id,
        after: { contactId: contact.id },
      });
    },
    { module: 'feedbackSurveys', revalidate: '/staff/interactions' },
  );
}

export async function reviewInteractionAction(data: FormData) {
  const id = z.string().uuid().safeParse(data.get('id'));
  if (!id.success) return { ok: false, error: 'Ungültiger Vorgang.' };
  return withStaff(
    async (tx, g) => {
      const row = await tx.clientInteraction.findUnique({ where: { id: id.data } });
      if (!row) throw new ActionError('Vorgang nicht gefunden.');
      await assertModuleEnabled(
        g.ctx,
        row.kind === 'NOTICE' ? 'noticeDecisions' : 'feedbackSurveys',
      );
      await assertClientAccessTx(tx, g.session, row.clientId);
      const revoke = data.get('revoke') === '1';
      if (revoke && row.status !== 'OPEN')
        throw new ActionError('Nur offene Anfragen können zurückgezogen werden.');
      if (!revoke && row.status !== 'RESPONDED')
        throw new ActionError('Es liegt noch keine Antwort vor.');
      await tx.clientInteraction.update({
        where: { id: row.id },
        data: revoke
          ? { status: 'REVOKED' }
          : { reviewedAt: new Date(), reviewedByStaff: g.staffId },
      });
      await tx.request.update({
        where: { id: row.requestId },
        data: { status: 'CLOSED', closedAt: new Date(), closedByStaff: g.staffId },
      });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'STAFF',
        actorId: g.staffId,
        action: revoke ? 'interaction.revoked' : 'interaction.reviewed',
        resourceType: 'client_interaction',
        resourceId: row.id,
        after: { kind: row.kind },
      });
    },
    { revalidate: '/staff/interactions' },
  );
}
