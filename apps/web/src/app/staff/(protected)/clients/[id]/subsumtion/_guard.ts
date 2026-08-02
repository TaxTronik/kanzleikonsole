// Gemeinsamer Page-Guard für den Subsumtions-Workspace.
// Zugang über die zentrale `canAccessClient`-Policy (OPEN-Default: jeder aktive
// Mitarbeiter; vertrauliche Mandanten nur Admin/Partner + Zugeordnete); zudem
// muss das Modul `risk` aktiv sein. Lädt nebenbei die Staff-Optionen (für die
// Panels) und ob die Engine konfiguriert ist. Redirect bei fehlender Berechtigung.

import { redirect } from 'next/navigation';
import { requireStaffPage } from '@/server/auth/staff-page';
import { canAccessClient, canOtherStaffAccessClientTx } from '@/server/auth/rbac';
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
  const session = await requireStaffPage();
  const { tenantId, staffId, fullName } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  const [modules, allowed, staffCandidates] = await Promise.all([
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

  // Nur Personen anbieten, die den Mandanten auch sehen dürfen. Vorher standen
  // alle aktiven Mitarbeiter in der Liste — bei einem vertraulichen Mandanten
  // liess sich damit an Unbefugte zuweisen. Die Server-Actions prüfen das
  // ebenfalls; diese Filterung ist der Komfort davor, nicht der Schutz.
  const staffOptions = await withTenantContext(ctx, async (tx) => {
    const zulaessig = await Promise.all(
      staffCandidates.map((s) => canOtherStaffAccessClientTx(tx, tenantId, s.id, clientId)),
    );
    return staffCandidates.filter((_, i) => zulaessig[i]);
  });

  return { ctx, staffId, fullName, staffOptions, engineConfigured: isRiskLayerConfigured() };
}
