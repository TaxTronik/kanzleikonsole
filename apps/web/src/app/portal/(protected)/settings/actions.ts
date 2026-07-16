'use server';

import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { withPortalContext, ActionError } from '@/server/actions/portal-action';
import {
  countRevocableGranted,
  parseConsent,
  revokeVoluntaryConsent,
} from '@/server/privacy/consent';

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

/** Art. 7 Abs. 3 DSGVO: vollständiger Widerruf im selben Self-Service-Kanal. */
export async function revokeOwnConsentAction(): Promise<void> {
  const r = await withPortalContext(
    async (tx, { tenantId, contactId, clientId }) => {
      const [contact, previous] = await Promise.all([
        tx.clientContact.findFirst({
          where: { id: contactId, clientId },
          select: { fullName: true },
        }),
        tx.clientConsent.findFirst({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      if (!contact) throw new ActionError('Kontakt nicht gefunden.');
      if (!previous) return;
      const previousConsent = parseConsent(previous.consents);
      const revokedCount = countRevocableGranted(previousConsent);
      if (revokedCount === 0) return;
      if (previous.signedByContact !== contactId) {
        throw new ActionError(
          'Dieser Einwilligungsstand wurde nicht Ihrem Portal-Kontakt zugeordnet. Bitte wenden Sie sich für den Widerruf an die Kanzlei.',
        );
      }

      const row = await tx.clientConsent.create({
        data: {
          tenantId,
          clientId,
          noticeVersion: previous.noticeVersion,
          // Für einen Widerruf ist keine neue Annahme nötig. Der bisherige
          // Snapshot bleibt der richtige Kontext der zurückgezogenen Erklärung.
          noticeSnapshot: previous.noticeSnapshot,
          consents: revokeVoluntaryConsent(previousConsent) as object,
          source: 'PORTAL',
          signedByName: contact.fullName,
          signedByContact: contactId,
          isRevocation: true,
          note: 'Widerruf freiwilliger Einwilligungen im Mandantenportal',
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'privacy.consent.revoke',
        resourceType: 'client_consent',
        resourceId: row.id,
        after: {
          clientId,
          source: 'PORTAL',
          revokedCount,
        },
      });
    },
    { revalidate: '/portal/settings' },
  );

  if (!r.ok) {
    log.warn(
      { component: 'portal-settings', err: r.error },
      'revokeOwnConsentAction fehlgeschlagen',
    );
  }
}
