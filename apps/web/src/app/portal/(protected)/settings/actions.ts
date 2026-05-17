'use server';

import { revalidatePath } from 'next/cache';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export async function saveNotificationSettingAction(formData: FormData): Promise<void> {
  const session = await portalAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  const { tenantId, contactId } = session.user;
  const enabled = formData.get('enabled') === 'on';

  await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const before = await tx.clientContact.findUnique({
        where: { id: contactId },
        select: { notificationsEnabled: true },
      });
      if (!before) throw new Error('Kontakt nicht gefunden.');
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
  );

  revalidatePath('/portal/settings');
}
