'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { withTenantContext } from '@taxtronik/db';
import { portalAuth } from '@/server/auth/portal';
import { resolvePortalProfileSwitchTx } from '@/server/auth/portal-profiles';
import { writePortalSession } from '@/server/auth/portal-session';
import { evidenceService } from '@/server/container';
import { safePortalReturnTo } from '../(auth)/login/verify/safe-return-to';

const SwitchProfileSchema = z.object({
  contactId: z.string().uuid(),
});

export async function switchPortalProfileAction(formData: FormData): Promise<void> {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  // Optionaler Rücksprung nach dem Wechsel (z. B. Anforderungs-Detail nach
  // E-Mail-Link im falschen Profil). Open-Redirect-sicher via safePortalReturnTo.
  const returnTo = safePortalReturnTo((formData.get('returnTo') as string | null) ?? undefined);

  const parsed = SwitchProfileSchema.safeParse({ contactId: formData.get('contactId') });
  if (!parsed.success) redirect('/portal/dashboard');

  const { tenantId, contactId: currentContactId } = session.user;
  if (parsed.data.contactId === currentContactId) redirect(returnTo);

  const target = await withTenantContext(
    { tenantId, actorId: currentContactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const resolved = await resolvePortalProfileSwitchTx(tx, {
        tenantId,
        currentContactId,
        email: session.user.email,
        targetContactId: parsed.data.contactId,
      });
      if (!resolved) return null;
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: currentContactId,
        action: 'auth.portal.profile.switch',
        resourceType: 'client_contact',
        resourceId: resolved.contactId,
        after: { fromContactId: currentContactId, clientId: resolved.clientId },
      });
      await tx.clientContact.update({
        where: { id: resolved.contactId },
        data: { lastLoginAt: new Date() },
      });
      return resolved;
    },
  );
  if (!target) redirect('/portal/dashboard');

  await writePortalSession(
    {
      id: target.contactId,
      tenantId,
      clientId: target.clientId,
      email: target.email,
      fullName: target.contactName,
    },
    {
      sessionIssuedAt: session.user.sessionIssuedAt,
      sessionOriginContactId: session.user.sessionOriginContactId,
    },
  );
  redirect(returnTo);
}
