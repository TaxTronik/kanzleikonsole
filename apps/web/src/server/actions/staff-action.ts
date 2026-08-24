// =============================================================================
// Zentrale Bausteine für Staff-Server-Actions — eliminieren die ~275× von Hand
// kopierte Sicherheits-Zeremonie (Auth → Tenant-Kontext → Audit-Tx → Revalidate).
//
// Sicherheitsrelevant: der Admin-Check liegt jetzt an EINER Stelle statt 63×
// einzeln „erinnert" zu werden (vergessene Zeile = Privilege Escalation). Der
// Authz-Struktur-Guardrail (server-action-authz.test.ts) erkennt diese Helfer
// als gültige Autorisierung.
//
// Zwei Stufen:
//   • staffActionGuard(opts) — nur das Auth-Gate (+ optional Admin) + Kontext.
//     Universell: passt zu Actions, die danach eigene Services/Tx aufrufen.
//   • withStaff(fn, opts)    — Voll-Wrapper: Gate + Tenant-Tx + Fehler-Mapping
//     (toActionError) + optional Revalidate. Für inline-Tx-Actions (CRUD).
// =============================================================================

import { revalidatePath } from 'next/cache';
// Subpath statt Barrel: hält owner-client (verlangt DATABASE_URL beim Import) aus
// reinen Unit-Tests heraus, die dieses Modul transitiv ziehen (wie rbac.ts).
import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { TenantContext, TenantTransactionOptions, TxClient } from '@taxtronik/db';
import { staffAuth, type StaffSession } from '@/server/auth/staff';
import {
  isStaffAdmin,
  hasStaffPermission,
  toActionError,
  ActionError,
  type ActionErrorResult,
  type StaffPermissionName,
} from '@/server/auth/rbac';
import { decideStaffGuard } from './staff-action-policy';
import type { ActionResult } from './types';
import {
  assertModuleEnabled,
  isModeModuleEnabled,
  ModuleDisabledError,
  readModules,
  type BooleanModuleKey,
  type ModeModuleKey,
} from '@/server/settings/modules';

// Domänen-Fehler mit UI-tauglicher Message — innerhalb eines withStaff-Callbacks
// werfen, um eine konkrete Meldung an den Client zu geben (statt generisch).
export { ActionError };
export { decideStaffGuard };
export { parseFormData } from './form-data';

// Einheitliches Action-Ergebnis liegt neutral in ./types — hier re-exportiert,
// damit der bestehende Import-Pfad '@/server/actions/staff-action' stabil bleibt.
export type { ActionResult } from './types';

export interface StaffCtx {
  session: StaffSession;
  ctx: TenantContext;
  tenantId: string;
  staffId: string;
}

export type StaffGuardResult = ({ ok: true } & StaffCtx) | ActionErrorResult;
export type StaffGuardOptions = {
  requireAdmin?: boolean;
  requirePermission?: StaffPermissionName;
  module?: BooleanModuleKey;
  /** Module mit Betriebsmodus (OFF = vollständig deaktiviert). */
  modeModule?: ModeModuleKey;
};
export type WithStaffOptions = StaffGuardOptions & {
  uniqueError?: string;
  revalidate?: string | string[];
  /** Stabiler DB-Snapshot für beweisorientierte Mehrfach-Reads. */
  transactionIsolationLevel?: TenantTransactionOptions['isolationLevel'];
};

/**
 * Auth-Gate für Staff-Actions: prüft Session (+ optional Admin) und liefert
 * Session + Tenant-Kontext. Discriminated Union → Caller: `if (!g.ok) return g;`.
 */
export async function staffActionGuard(opts: StaffGuardOptions = {}): Promise<StaffGuardResult> {
  const session = await staffAuth();
  const denied = decideStaffGuard({
    hasUser: !!session?.user,
    isAdmin: isStaffAdmin(session),
    requireAdmin: opts.requireAdmin ?? false,
    requiredPermission: opts.requirePermission ?? null,
    hasPermission: opts.requirePermission
      ? hasStaffPermission(session, opts.requirePermission)
      : true,
  });
  if (denied || !session?.user) return { ok: false, error: denied ?? 'Nicht eingeloggt.' };
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  if (opts.module) {
    try {
      await assertModuleEnabled(ctx, opts.module);
    } catch (error) {
      if (error instanceof ModuleDisabledError) return { ok: false, error: error.message };
      throw error;
    }
  }
  if (opts.modeModule) {
    const modules = await readModules(ctx);
    if (!isModeModuleEnabled(modules, opts.modeModule)) {
      const label = opts.modeModule === 'poa' ? 'Vollmachten' : 'Rechnungen';
      return { ok: false, error: `Das Modul ${label} ist deaktiviert.` };
    }
  }
  return {
    ok: true,
    session,
    ctx,
    tenantId,
    staffId,
  };
}

/**
 * Voll-Wrapper: Gate → Tenant-Tx → `fn(tx, ctx)` → Fehler→ActionResult
 * (toActionError, kein Leak roher Messages) → optional Revalidate. Die Nutzlast
 * von `fn` wird flach ins Ergebnis gemischt (`{ ok: true, ...payload }`).
 * `uniqueError`: freundliche Meldung für P2002 (Eindeutigkeits-Konflikt).
 */
export async function withStaff<T extends Record<string, unknown> = Record<string, never>>(
  fn: (tx: TxClient, ctx: StaffCtx) => Promise<T | void>,
  opts: WithStaffOptions = {},
): Promise<ActionResult & Partial<T>> {
  // Fehlerpfade tragen keine T-Felder → Cast nach Partial<T> ist korrekt
  // (TS kann das über das generische Partial<T> nur nicht selbst beweisen).
  type R = ActionResult & Partial<T>;
  const guard = await staffActionGuard(opts);
  if (!guard.ok) return guard as R;
  try {
    const run = (tx: TxClient) => fn(tx, guard);
    const data = opts.transactionIsolationLevel
      ? await withTenantContext(guard.ctx, run, {
          isolationLevel: opts.transactionIsolationLevel,
        })
      : await withTenantContext(guard.ctx, run);
    if (opts.revalidate)
      for (const p of ([] as string[]).concat(opts.revalidate)) revalidatePath(p);
    return { ok: true, ...(data ?? {}) } as R;
  } catch (e) {
    if (opts.uniqueError && (e as { code?: string }).code === 'P2002') {
      return { ok: false, error: opts.uniqueError } as R;
    }
    return toActionError(e) as R;
  }
}

/**
 * Bindet einen Action-Baustein einmalig an ein tenantweites Modul. Dadurch
 * können Dateien mit vielen Actions das Gate nicht bei einzelnen Writes
 * versehentlich auslassen; Spezialoptionen wie Admin/Permission bleiben aktiv.
 */
export function withStaffModule(module: BooleanModuleKey) {
  return function withBoundStaff<T extends Record<string, unknown> = Record<string, never>>(
    fn: (tx: TxClient, ctx: StaffCtx) => Promise<T | void>,
    opts: Omit<WithStaffOptions, 'module'> = {},
  ): Promise<ActionResult & Partial<T>> {
    return withStaff(fn, { ...opts, module });
  };
}

export function staffModuleActionGuard(
  module: BooleanModuleKey,
  opts: Omit<StaffGuardOptions, 'module'> = {},
): Promise<StaffGuardResult> {
  return staffActionGuard({ ...opts, module });
}
