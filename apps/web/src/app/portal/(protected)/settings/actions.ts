'use server';

import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { withPortalContext, ActionError } from '@/server/actions/portal-action';

export async function saveNotificationSettingAction(formData: FormData): Promise<void> {
  const enabled = formData.get('enabled') === 'on';

  const r = await withPortalContext(
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

  // Befund 9: das ActionResult von withPortalContext wurde vorher weggeworfen.
  // Der Call-Site ist ein plain <form action> ohne Result-Channel (Signatur
  // bleibt deshalb Promise<void>) — Fehler mindestens strukturiert loggen.
  if (!r.ok) {
    log.warn(
      { component: 'portal-settings', err: r.error },
      'saveNotificationSettingAction fehlgeschlagen',
    );
  }
}
