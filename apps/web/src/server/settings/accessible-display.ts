import 'server-only';

import { cache } from 'react';
import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import {
  DEFAULT_DISPLAY_OPTIONS,
  DISPLAY_OPTIONS_SELECT,
  displayOptionsFromProfile,
  type AccessibleDisplayOptions,
} from '@/lib/accessible-display-options';

// Request-scoped and keyed by the complete actor identity. Never use a shared
// browser preference or a tenant-wide setting for this personal display mode.
const readAccessibleDisplayCached = cache(
  async (tenantId: string, actorId: string, actorType: 'STAFF' | 'CLIENT_CONTACT') =>
    withTenantContext({ tenantId, actorId, actorType }, async (tx) => {
      const where = { id: actorId, tenantId, active: true };
      const select = { accessibleDisplay: true, ...DISPLAY_OPTIONS_SELECT } as const;
      const account =
        actorType === 'STAFF'
          ? await tx.staffUser.findFirst({ where, select })
          : await tx.clientContact.findFirst({ where, select });
      return {
        enabled: account?.accessibleDisplay === true,
        options: displayOptionsFromProfile(account),
      };
    }),
);

/** Only pass a server-verified session context; this is not a public action. */
export async function readAccessibleDisplay(ctx: TenantContext): Promise<boolean> {
  if (!ctx.actorId || (ctx.actorType !== 'STAFF' && ctx.actorType !== 'CLIENT_CONTACT')) {
    return false;
  }
  return (await readAccessibleDisplayCached(ctx.tenantId, ctx.actorId, ctx.actorType)).enabled;
}

export async function readAccessibleDisplayOptions(
  ctx: TenantContext,
): Promise<AccessibleDisplayOptions> {
  if (!ctx.actorId || (ctx.actorType !== 'STAFF' && ctx.actorType !== 'CLIENT_CONTACT')) {
    return { ...DEFAULT_DISPLAY_OPTIONS };
  }
  return (await readAccessibleDisplayCached(ctx.tenantId, ctx.actorId, ctx.actorType)).options;
}
