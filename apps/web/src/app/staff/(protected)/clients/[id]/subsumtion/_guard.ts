// Gemeinsamer Page-Guard für den Subsumtions-Workspace.
// Zugang über die zentrale `canAccessClient`-Policy (OPEN-Default: jeder aktive
// Mitarbeiter; vertrauliche Mandanten nur Admin/Partner + Zugeordnete); zudem
// muss das Modul `risk` aktiv sein. Lädt nebenbei die Staff-Optionen (für die
// Panels) und ob die Engine konfiguriert ist. Redirect bei fehlender Berechtigung.

import { redirect } from 'next/navigation';
import { requireStaffPage } from '@/server/auth/staff-page';
import { canAccessClient, filterStaffAccessClientTx } from '@/server/auth/rbac';
import { loadSubsumtionRights, type SubsumtionRights } from '@/server/risk/rights';
import { readModules } from '@/server/settings/modules';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import { withTenantContext, type TenantContext } from '@taxtronik/db';

export interface SubsumtionPageContext {
  ctx: TenantContext;
  staffId: string;
  fullName: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  /**
   * Volle Bearbeitungsrechte: Admin/Partner oder zugeordnete:r Berufstraeger/
   * Hauptbearbeiter:in. Wer nur eine Markierung zugewiesen bekam, sieht den
   * Space lesend und darf ausschliesslich dort recherchieren. Die Durchsetzung
   * sitzt in den Server Actions — dieses Flag blendet nur aus, was ohnehin
   * abgelehnt wuerde.
   */
  canWrite: boolean;
  /**
   * Dieselbe Rechtelage wie in den Server Actions — inklusive der Markierungen,
   * die dieser Person zugewiesen sind. Wird gebraucht, um bei einer als
   * vertraulich gekennzeichneten Analyse genau diese Stellen freizugeben.
   */
  rights: SubsumtionRights;
}

export async function guardSubsumtionPage(
  clientId: string,
  analysisId?: string,
): Promise<SubsumtionPageContext> {
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
    const zulaessig = await filterStaffAccessClientTx(
      tx,
      tenantId,
      staffCandidates.map((s) => s.id),
      clientId,
    );
    return staffCandidates.filter((s) => zulaessig.has(s.id));
  });

  const rights = await withTenantContext(ctx, (tx) =>
    loadSubsumtionRights(tx, session, { clientId, analysisId }),
  );

  return {
    ctx,
    staffId,
    fullName,
    staffOptions,
    engineConfigured: isRiskLayerConfigured(),
    canWrite: rights.canWrite,
    rights,
  };
}
