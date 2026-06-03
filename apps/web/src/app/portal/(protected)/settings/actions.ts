'use server';

import { evidenceService } from '@/server/container';
import { withPortalContext, ActionError } from '@/server/actions/portal-action';

export async function saveNotificationSettingAction(formData: FormData): Promise<void> {
  const enabled = formData.get('enabled') === 'on';

  await withPortalContext(
    async (tx, { tenantId, contactId }) => {
      const before = await tx.clientContact.findUnique({
        where: { id: contactId },
        select: { notificationsEnabled: true },
      });
      if (!before) throw new ActionError('Kontakt nicht gefunden.');
      if (before.notificationsEnabled === enabled) return;

      await tx.clientContact.update({
        where: { id: contactId },
        data: { notificationsEnabled: enabled },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'portal.notifications.toggle',
        resourceType: 'client_contact',
        resourceId: contactId,
        before: { notificationsEnabled: before.notificationsEnabled },
        after: { notificationsEnabled: enabled },
      });
    },
    { revalidate: '/portal/settings' },
  );
}
