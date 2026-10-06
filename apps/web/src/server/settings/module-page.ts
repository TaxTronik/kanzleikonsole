// =============================================================================
// Seiten-Gate für Modulseiten: dieselbe Registry (lib/module-registry.ts) wie
// Navigation und Layout-Gate.
//
// Das Layout-Gate allein genügt nicht: Layouts rendern bei Navigation zwischen
// Unterseiten nicht erneut, und ein gezielt gebauter RSC-Request kann das
// Layout überspringen. Deshalb ruft jede Seite unter einem Registry-Pfad
// requireModulePage() selbst (Guard-Test: src/__tests__/module-page-guard.test.ts).
// Deaktiviert → 404 wie das Layout-Gate. `cache()` liest die Modulkonfiguration
// pro Request nur einmal.
// =============================================================================

import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { TenantContext } from '@taxtronik/db';
import { isModuleAreaEnabled, type ModuleAreaKey, type ModuleSurface } from '@/lib/module-registry';
import { readModules, type ModuleConfig } from './modules';

const readModulesOnce = cache(
  (tenantId: string, actorId: string, actorType: TenantContext['actorType']) =>
    readModules({ tenantId, actorId, actorType }),
);

// Je Oberfläche nur deren Auth-Modul laden (Staff-Seiten ziehen kein Portal-Auth).
async function pageContext(surface: ModuleSurface): Promise<TenantContext & { actorId: string }> {
  if (surface === 'staff') {
    const { staffAuth } = await import('@/server/auth/staff');
    const session = await staffAuth();
    if (!session?.user) redirect('/staff/login');
    return { tenantId: session.user.tenantId, actorId: session.user.staffId, actorType: 'STAFF' };
  }
  const { portalAuth } = await import('@/server/auth/portal');
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  return {
    tenantId: session.user.tenantId,
    actorId: session.user.contactId,
    actorType: 'CLIENT_CONTACT',
  };
}

/** Bricht mit 404 ab, wenn der Registry-Bereich der Seite deaktiviert ist. */
export async function requireModulePage(
  surface: ModuleSurface,
  area: ModuleAreaKey,
): Promise<ModuleConfig> {
  const ctx = await pageContext(surface);
  const modules = await readModulesOnce(ctx.tenantId, ctx.actorId, ctx.actorType);
  if (!isModuleAreaEnabled(modules, area)) notFound();
  return modules;
}
