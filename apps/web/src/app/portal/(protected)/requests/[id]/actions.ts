'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notify } from '@/server/notifications/service';
import { checkPortalWriteLimit } from '@/server/rate-limit';

const ResponseSchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(5000),
  documentId: z.string().uuid().optional().or(z.literal('')),
});

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function addPortalResponseAction(formData: FormData): Promise<ActionResult> {
  const session = await portalAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };

  // S4: globaler Portal-Schreib-Backstop. Notification-Idempotenz greift
  // hier nicht (jede Response-ID ist neu) — Symmetrie zu NEW4.
  const rl = await checkPortalWriteLimit(session.user.contactId);
  if (!rl.ok) {
    return { ok: false, error: `Zu viele Aktionen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.` };
  }

  const parsed = ResponseSchema.safeParse({
    requestId: formData.get('requestId'),
    message: formData.get('message'),
    documentId: formData.get('documentId') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, contactId, clientId } = session.user;
  const { requestId, message, documentId } = parsed.data;

  await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      // Sicherheits-Check: gehört der Request wirklich diesem Mandanten?
      const req = await tx.request.findFirst({
        where: { id: requestId, clientId },
      });
      if (!req) throw new Error('Anforderung nicht gefunden.');

      // H7: Document-Owner-Check. Ohne diese Prüfung könnte ein Portal-User
      // per geratener Document-UUID ein fremdes Dokument an die eigene
      // Anfrage hängen — UUID-Raten ist zwar unwahrscheinlich, aber die
      // Prüfung kostet eine Zeile und schließt die Lücke definitiv.
      if (documentId) {
        const doc = await tx.document.findFirst({
          where: { id: documentId, clientId },
          select: { id: true },
        });
        if (!doc) throw new Error('Dokument nicht gefunden.');
      }

      const resp = await tx.requestResponse.create({
        data: {
          requestId,
          authorType: 'CLIENT_CONTACT',
          authorId: contactId,
          message,
          documentId: documentId || null,
        },
      });

      await tx.request.update({
        where: { id: requestId },
        data: { status: 'RESPONDED' },
      });

      // In-App-Notification an den Staff, der die Anforderung erstellt hat
      await notify(tx, {
        tenantId,
        staffId: req.createdByStaff,
        kind: 'REQUEST_RESPONDED',
        title: `${req.title} — Mandant hat geantwortet`,
        body: message.slice(0, 200) + (message.length > 200 ? '…' : ''),
        href: `/staff/requests/${requestId}`,
        resourceType: 'request',
        resourceId: requestId,
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'request.response',
        resourceType: 'request_response',
        resourceId: resp.id,
        after: { requestId, length: message.length, documentId: documentId || null },
      });
    },
  );

  emitN8nEvent('request.responded', {
    tenantId,
    requestId,
    by: 'CLIENT_CONTACT',
  });
  revalidatePath(`/portal/requests/${requestId}`);
  revalidatePath('/portal/requests');
  return { ok: true };
}
