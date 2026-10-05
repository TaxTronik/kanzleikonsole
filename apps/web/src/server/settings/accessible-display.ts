import 'server-only';

import type { TenantContext } from '@taxtronik/db';
import {
  DEFAULT_DISPLAY_OPTIONS,
  displayOptionsFromProfile,
  type AccessibleDisplayOptions,
} from '@/lib/accessible-display-options';
import { readLayoutSettingsSource, type AccountDisplaySource } from './layout-settings';

// Request-scoped and keyed by the complete actor identity (layout-settings.ts).
// Never use a shared browser preference or a tenant-wide setting for this
// personal display mode; it is therefore never cached across requests.

export interface AccessibleDisplaySetting {
  enabled: boolean;
  options: AccessibleDisplayOptions;
}

export function accessibleDisplayFromAccount(
  account: AccountDisplaySource | null,
): AccessibleDisplaySetting {
  return {
    enabled: account?.accessibleDisplay === true,
    options: displayOptionsFromProfile(account),
  };
}

function isPersonalActor(ctx: TenantContext): boolean {
  return Boolean(ctx.actorId) && (ctx.actorType === 'STAFF' || ctx.actorType === 'CLIENT_CONTACT');
}

/** Only pass a server-verified session context; this is not a public action. */
export async function readAccessibleDisplay(ctx: TenantContext): Promise<boolean> {
  if (!isPersonalActor(ctx)) return false;
  return accessibleDisplayFromAccount((await readLayoutSettingsSource(ctx)).account).enabled;
}

export async function readAccessibleDisplayOptions(
  ctx: TenantContext,
): Promise<AccessibleDisplayOptions> {
  if (!isPersonalActor(ctx)) return { ...DEFAULT_DISPLAY_OPTIONS };
  return accessibleDisplayFromAccount((await readLayoutSettingsSource(ctx)).account).options;
}
