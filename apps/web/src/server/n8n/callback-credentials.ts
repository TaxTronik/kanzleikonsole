import { createHash, randomBytes } from 'node:crypto';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface RotatedN8nCallbackCredential {
  token: string;
  connection: {
    id: string;
    callbackKeyId: string;
    callbackScopes: string[];
    callbackBaseUrl: string | null;
    kind: 'BUNDLED' | 'SELF_HOSTED' | 'CLOUD';
  };
}

/**
 * Rotiert Token-Hash und Scopes zusammen mit dem Audit-Eintrag in genau einer
 * Tenant-Transaktion. Der Klartext verlaesst die Funktion erst, nachdem die
 * Transaktion inklusive Evidence-Write erfolgreich committed wurde.
 */
export async function rotateN8nCallbackCredential(
  ctx: TenantContext,
  callbackScopes: string[],
): Promise<RotatedN8nCallbackCredential> {
  return withTenantContext(ctx, async (tx) => {
    const token = `ttn8n_${randomBytes(36).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const connection = await tx.n8nConnection.update({
      where: { tenantId: ctx.tenantId },
      data: { callbackTokenHash: tokenHash, callbackScopes },
      select: {
        id: true,
        callbackKeyId: true,
        callbackScopes: true,
        callbackBaseUrl: true,
        kind: true,
      },
    });

    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.callback_token.rotate',
      resourceType: 'n8n_connection',
      resourceId: connection.id,
      after: {
        callbackKeyId: connection.callbackKeyId,
        scopes: connection.callbackScopes,
        token: '***',
      },
    });

    return { token, connection };
  });
}

/** Erweitert Berechtigungen eines bestehenden Tokens, ohne es zu rotieren. */
export async function grantN8nCallbackScopes(
  ctx: TenantContext,
  callbackScopes: string[],
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const connection = await tx.n8nConnection.update({
      where: { tenantId: ctx.tenantId },
      data: { callbackScopes },
      select: { id: true, callbackKeyId: true },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.callback_scope.update',
      resourceType: 'n8n_connection',
      resourceId: connection.id,
      after: { callbackKeyId: connection.callbackKeyId, scopes: callbackScopes },
    });
  });
}
