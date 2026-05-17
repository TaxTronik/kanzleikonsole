// =============================================================================
// Mail-Dispatch-Modus pro Tenant
//
// Legt fest, wer die App-Mails versendet:
//   - APP  (Default): App-SMTP versendet direkt aus den EmailTemplates der DB
//   - BOTH: App versendet wie oben PLUS n8n-Event wird zusätzlich emittiert
//           (für externe Integrationen wie Slack-Ping, CRM-Sync)
//
// Bewusst kein `N8N`-only-Modus: die App muss in jedem Fall den
// Mail-Versand zuverlässig übernehmen können — n8n bleibt optionale
// Erweiterung, nicht Single-Point-of-Failure.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';

export type MailDispatchMode = 'APP' | 'BOTH';

export interface MailDispatchConfig {
  mode: MailDispatchMode;
}

export const DEFAULT_DISPATCH: MailDispatchConfig = {
  mode: 'APP',
};

const KEY = 'mail.dispatch';

function normalize(value: unknown): MailDispatchConfig {
  const v = (value ?? {}) as Partial<MailDispatchConfig>;
  return {
    mode: v.mode === 'BOTH' ? 'BOTH' : 'APP',
  };
}

export async function readMailDispatch(ctx: TenantContext): Promise<MailDispatchConfig> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
    });
    return row ? normalize(row.value) : DEFAULT_DISPATCH;
  });
}

export async function writeMailDispatch(
  ctx: TenantContext,
  cfg: MailDispatchConfig,
): Promise<void> {
  const stored = normalize(cfg);
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY,
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}
