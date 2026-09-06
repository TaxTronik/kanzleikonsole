import type { TxClient } from '@taxtronik/db';
import { parseBooleanTenantModules } from '@taxtronik/db/tenant-modules';

/** Called after the token exchange, within the initiating staff actor's transaction.
 * Share locks keep module/role revocation serialized with credential persistence. */
export async function persistMicrosoftOauthCacheTx(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  mailboxId: string,
  encryptedCache: string,
): Promise<void> {
  const settings = await tx.$queryRaw<Array<{ value: unknown }>>`
    SELECT value FROM tenant_setting
    WHERE tenant_id=${tenantId}::uuid AND tenant_id=app.current_tenant_id() AND key='modules'
    FOR SHARE`;
  if (!parseBooleanTenantModules(settings[0]?.value).smartMailbox)
    throw new Error('Mailbox authorization changed.');
  const staff = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id
    WHERE s.id=${staffId}::uuid AND s.tenant_id=${tenantId}::uuid AND s.active
      AND s.id=app.current_actor_id() AND s.tenant_id=app.current_tenant_id()
      AND app.current_actor_type()='STAFF' AND r.role IN ('ADMIN','PARTNER')
    FOR SHARE OF s,r`;
  if (!staff.length) throw new Error('Mailbox authorization changed.');
  const saved = await tx.inboundMailbox.updateMany({
    where: { id: mailboxId, tenantId, provider: 'MICROSOFT365' },
    data: { oauthCacheEnc: encryptedCache, lastError: null },
  });
  if (saved.count !== 1) throw new Error('Mailbox authorization changed.');
}
