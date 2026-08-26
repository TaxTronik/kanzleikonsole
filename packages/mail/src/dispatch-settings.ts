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
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';

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
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY);
    return value === undefined ? DEFAULT_DISPATCH : normalize(value);
  });
}

export async function writeMailDispatch(
  ctx: TenantContext,
  cfg: MailDispatchConfig,
): Promise<void> {
  const stored = normalize(cfg);
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY,
      value: stored as object,
      updatedBy: ctx.actorId,
    });
  });
}
