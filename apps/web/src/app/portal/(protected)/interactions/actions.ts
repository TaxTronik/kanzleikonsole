'use server';
import { z } from 'zod';
import { withPortalContext, ActionError } from '@/server/actions/portal-action';
import { assertModuleEnabled } from '@/server/settings/modules';
import { noticeDecisionSnapshot, validInteractionResponse } from '@/server/workflows/interactions';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { checkPortalWriteLimit } from '@/server/rate-limit';
import { createHash } from 'node:crypto';
import type { ClientInteraction } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { PortalCtx } from '@/server/actions/portal-action';

async function assertNoticeInteractionCurrentTx(
  tx: TxClient,
  g: PortalCtx,
  row: ClientInteraction,
): Promise<void> {
  if (row.kind !== 'NOTICE') return;
  await assertModuleEnabled(g.ctx, 'taxNotices');
  const snapshot = noticeDecisionSnapshot.parse(row.snapshot);
  await tx.$queryRaw`SELECT id FROM tax_notice WHERE id=${row.sourceId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM document WHERE id=${snapshot.documentId}::uuid FOR SHARE`;
  const notice = await tx.taxNotice.findUnique({
    where: { id: row.sourceId },
    include: {
      document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } },
    },
  });
  if (
    !notice ||
    notice.status !== 'GEPRUEFT' ||
    notice.updatedAt.toISOString() !== snapshot.noticeUpdatedAt ||
    !notice.document?.sharedWithClientAt ||
    notice.document.deletedAt ||
    notice.document.versions[0]?.id !== snapshot.documentVersionId
  )
    throw new ActionError(
      'Der Bescheidstand wurde geändert. Bitte eine neue Anfrage von Ihrer Kanzlei anfordern.',
    );
}

async function notifyInteractionResponseTx(
  tx: TxClient,
  g: PortalCtx,
  row: ClientInteraction,
  response: string,
): Promise<void> {
  if (!(row.kind === 'NOTICE' || Number(response) <= 2)) return;
  const recipients = await tx.$queryRaw<
    Array<{ staff_id: string }>
  >`SELECT staff_id FROM app.interaction_notification_recipients(${row.id}::uuid)`;
  for (const recipient of recipients)
    await notify(tx, {
      tenantId: g.tenantId,
      staffId: recipient.staff_id,
      kind: 'REQUEST_RESPONDED',
      title:
        row.kind === 'NOTICE'
          ? 'Bescheid-Rückmeldung eingegangen'
          : 'Service-Rückmeldung benötigt Aufmerksamkeit',
      href: '/staff/interactions',
      resourceType: 'request',
      resourceId: row.requestId,
    });
}

export async function respondInteractionAction(data: FormData) {
  const parsed = z
    .object({
      id: z.string().uuid(),
      response: z.string(),
      message: z.string().max(3000).default(''),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { ok: false, error: 'Antwort prüfen.' };
  return withPortalContext(
    async (tx, g) => {
      if (!(await checkPortalWriteLimit(g.contactId)).ok)
        throw new ActionError('Zu viele Aktionen. Bitte später erneut versuchen.');
      await tx.$queryRaw`SELECT id FROM client_interaction WHERE id=${parsed.data.id}::uuid FOR UPDATE`;
      const row = await tx.clientInteraction.findUnique({ where: { id: parsed.data.id } });
      if (!row || row.contactId !== g.contactId || row.clientId !== g.clientId)
        throw new ActionError('Anfrage nicht gefunden.');
      await assertModuleEnabled(
        g.ctx,
        row.kind === 'NOTICE' ? 'noticeDecisions' : 'feedbackSurveys',
      );
      if (row.status !== 'OPEN' || row.expiresAt <= new Date())
        throw new ActionError('Anfrage ist nicht mehr offen. Bitte kontaktieren Sie Ihre Kanzlei.');
      await tx.$queryRaw`SELECT id FROM request WHERE id=${row.requestId}::uuid FOR UPDATE`;
      const request = await tx.request.findUnique({
        where: { id: row.requestId },
        select: { status: true },
      });
      if (!request || !['OPEN', 'IN_PROGRESS'].includes(request.status))
        throw new ActionError(
          'Die Kanzlei hat diese Anfrage geschlossen. Bitte kontaktieren Sie Ihre Kanzlei.',
        );
      if (!validInteractionResponse(row.kind, parsed.data.response))
        throw new ActionError('Ungültige Antwort.');
      await assertNoticeInteractionCurrentTx(tx, g, row);
      const changed = await tx.clientInteraction.updateMany({
        where: {
          id: row.id,
          status: 'OPEN',
          contactId: g.contactId,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: 'RESPONDED',
          response: parsed.data.response,
          message: parsed.data.message || null,
          respondedAt: new Date(),
        },
      });
      if (changed.count !== 1) throw new ActionError('Anfrage wurde zwischenzeitlich geschlossen.');
      await tx.request.updateMany({
        where: { id: row.requestId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        data: { status: 'RESPONDED' },
      });
      await notifyInteractionResponseTx(tx, g, row, parsed.data.response);
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: g.contactId,
        action: 'interaction.responded',
        resourceType: 'client_interaction',
        resourceId: row.id,
        after: {
          kind: row.kind,
          response: parsed.data.response,
          revision: row.revision,
          messageHash: createHash('sha256').update(parsed.data.message).digest('hex'),
        },
      });
    },
    { revalidate: ['/portal/interactions', '/portal/requests', '/staff/interactions'] },
  );
}
