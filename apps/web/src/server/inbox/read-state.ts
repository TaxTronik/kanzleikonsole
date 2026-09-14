import type { TxClient } from '@taxtronik/db';

/** Atomar vorwärts schreiben; verspätete Bestätigungen sind ein No-op. */
export async function advancePortalInboxReadTx(
  tx: TxClient,
  actor: { tenantId: string; clientId: string; contactId: string },
  threadId: string,
  readAt: Date,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO public.portal_inbox_read
      (tenant_id, client_id, thread_id, contact_id, last_read_at)
    VALUES
      (${actor.tenantId}::uuid, ${actor.clientId}::uuid, ${threadId}::uuid,
       ${actor.contactId}::uuid, ${readAt})
    ON CONFLICT (thread_id, contact_id) DO UPDATE
      SET last_read_at = EXCLUDED.last_read_at
      WHERE portal_inbox_read.last_read_at < EXCLUDED.last_read_at
  `;
}
