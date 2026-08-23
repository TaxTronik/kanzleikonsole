// =============================================================================
// Zentrale Bausteine für Mandanten-Portal-Server-Actions — das Pendant zu
// staff-action.ts für den CLIENT_CONTACT-Akteur. Eliminiert die 62× von Hand
// kopierte portalAuth-Zeremonie (Auth → Tenant-Kontext → Audit-Tx → Revalidate).
//
// Der Authz-Struktur-Guardrail (server-action-authz.test.ts) erkennt
// portalActionGuard/withPortalContext als gültige Autorisierung.
//
//   • portalActionGuard() — nur das Auth-Gate + Kontext (Portal hat keine
//     Admin-Stufe; Feature-Gating bleibt action-spezifisch).
//   • withPortalContext(fn, opts) — Voll-Wrapper: Gate + Tenant-Tx +
//     Fehler-Mapping (toActionError) + optional Revalidate.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { portalAuth, type PortalSession } from '@/server/auth/portal';
import { toActionError, ActionError } from '@/server/auth/rbac';
import type { ActionResult } from './types';
import {
  assertModuleEnabled,
  ModuleDisabledError,
  type BooleanModuleKey,
} from '@/server/settings/modules';

// Domänen-Fehler mit UI-tauglicher Message — im withPortalContext-Callback werfen.
export { ActionError };
export { parseFormData } from './form-data';
// Einheitliches Ergebnis (eine Import-Quelle für Portal-Actions).
export type { ActionResult } from './types';

export interface PortalCtx {
  session: PortalSession;
  ctx: TenantContext;
  tenantId: string;
  contactId: string;
  clientId: string;
}

export type PortalGuardResult = ({ ok: true } & PortalCtx) | { ok: false; error: string };
export type PortalGuardOptions = { module?: BooleanModuleKey };
export type WithPortalOptions = PortalGuardOptions & { revalidate?: string | string[] };

/**
 * Auth-Gate für Portal-Actions: prüft die Kontakt-Session und liefert Session +
 * Tenant-Kontext (actorType CLIENT_CONTACT). Discriminated Union → Caller:
 * `if (!g.ok) return g;`.
 */
export async function portalActionGuard(opts: PortalGuardOptions = {}): Promise<PortalGuardResult> {
  const session = await portalAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const { tenantId, contactId, clientId } = session.user;
  const ctx: TenantContext = {
    tenantId,
    actorId: contactId,
    actorType: 'CLIENT_CONTACT',
  };
  if (opts.module) {
    try {
      await assertModuleEnabled(ctx, opts.module);
    } catch (error) {
      if (error instanceof ModuleDisabledError) return { ok: false, error: error.message };
      throw error;
    }
  }
  return {
    ok: true,
    session,
    ctx,
    tenantId,
    contactId,
    clientId,
  };
}

/**
 * Voll-Wrapper: Gate → Tenant-Tx → `fn(tx, ctx)` → Fehler→ActionResult
 * (toActionError, kein Leak roher Messages) → optional Revalidate. Die Nutzlast
 * von `fn` wird flach ins Ergebnis gemischt (`{ ok: true, ...payload }`).
 */
export async function withPortalContext<T extends Record<string, unknown> = Record<string, never>>(
  fn: (tx: TxClient, ctx: PortalCtx) => Promise<T | void>,
  opts: WithPortalOptions = {},
): Promise<ActionResult & Partial<T>> {
  type R = ActionResult & Partial<T>;
  const guard = await portalActionGuard(opts);
  if (!guard.ok) return guard as R;
  try {
    const data = await withTenantContext(guard.ctx, (tx) => fn(tx, guard));
    if (opts.revalidate)
      for (const p of ([] as string[]).concat(opts.revalidate)) revalidatePath(p);
    return { ok: true, ...(data ?? {}) } as R;
  } catch (e) {
    return toActionError(e) as R;
  }
}

export function withPortalModule(module: BooleanModuleKey) {
  return function withBoundPortal<T extends Record<string, unknown> = Record<string, never>>(
    fn: (tx: TxClient, ctx: PortalCtx) => Promise<T | void>,
    opts: Omit<WithPortalOptions, 'module'> = {},
  ): Promise<ActionResult & Partial<T>> {
    return withPortalContext(fn, { ...opts, module });
  };
}

export function portalModuleActionGuard(module: BooleanModuleKey): Promise<PortalGuardResult> {
  return portalActionGuard({ module });
}
