// Gemeinsamer Page-Guard für den Subsumtions-Workspace.
// Zugang über die zentrale `canAccessClient`-Policy (OPEN-Default: jeder aktive
// Mitarbeiter; vertrauliche Mandanten nur Admin/Partner + Zugeordnete); zudem
// muss das Modul `risk` aktiv sein. Lädt nebenbei die Staff-Optionen (für die
// Panels) und ob die Engine konfiguriert ist. Redirect bei fehlender Berechtigung.

import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClient } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import { withTenantContext, type TenantContext } from '@taxtronik/db';

export interface SubsumtionPageContext {
  ctx: TenantContext;
  staffId: string;
  fullName: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
}

export async function guardSubsumtionPage(clientId: string): Promise<SubsumtionPageContext> {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId, fullName } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  const [modules, allowed, staffOptions] = await Promise.all([
    readModules(ctx),
    canAccessClient(session, clientId),
    withTenantContext(ctx, (tx) =>
      tx.staffUser.findMany({
        where: { active: true },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true },
      }),
    ),
  ]);

  if (!modules.risk || !allowed) redirect(`/staff/clients/${clientId}`);

  return { ctx, staffId, fullName, staffOptions, engineConfigured: isRiskLayerConfigured() };
}
