// =============================================================================
// Markierungs-Mutationen (tenant-scoped, RLS).
//
// Berater-Bearbeitung der vom Engine erkannten Stellen: Governance-Matrix,
// Status, Notiz, Verantwortlichkeit setzen; eigene (BERATER-)Markierungen
// anlegen; Markierungen löschen.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { GovernanceTyp, RiskStufe, RiskWk } from '@taxtronik/risk-layer';

export type RiskStatus = 'OFFEN' | 'IN_PRUEFUNG' | 'KONTROLLIERT' | 'AKZEPTIERT';

/** Berater-editierbare Felder einer Markierung. `undefined` = unverändert. */
export interface UpdateMarkingInput {
  governanceTyp?: GovernanceTyp | null;
  schadensintensitaet?: RiskStufe | null;
  wahrscheinlichkeit?: RiskWk | null;
  kaskadenreichweite?: number | null;
  kontrolle?: string | null;
  status?: RiskStatus;
  notiz?: string | null;
  verantwortlichId?: string | null;
  farbe?: string | null;
  label?: string | null;
}

export async function updateMarking(
  ctx: TenantContext,
  markingId: string,
  fields: UpdateMarkingInput,
): Promise<void> {
  await withTenantContext(ctx, (tx) =>
    tx.riskMarking.update({ where: { id: markingId }, data: fields }),
  );
}

export interface AddManualMarkingInput {
  analysisId: string;
  start: number;
  end: number;
  matchedText: string;
  begriff: string;
  normAnker?: string[];
  farbe?: string | null;
  label?: string | null;
  notiz?: string | null;
}

/** Legt eine berater-gesetzte Markierung an (Herkunft BERATER). */
export async function addManualMarking(
  ctx: TenantContext,
  input: AddManualMarkingInput,
): Promise<{ markingId: string }> {
  const marking = await withTenantContext(ctx, (tx) =>
    tx.riskMarking.create({
      data: {
        tenantId: ctx.tenantId,
        analysisId: input.analysisId,
        start: input.start,
        end: input.end,
        matchedText: input.matchedText,
        herkunft: 'BERATER',
        engineStatus: 'berater',
        begriff: input.begriff,
        normAnker: input.normAnker ?? [],
        farbe: input.farbe ?? null,
        label: input.label ?? null,
        notiz: input.notiz ?? null,
        status: 'OFFEN',
      },
      select: { id: true },
    }),
  );
  return { markingId: marking.id };
}

export async function deleteMarking(ctx: TenantContext, markingId: string): Promise<void> {
  await withTenantContext(ctx, (tx) => tx.riskMarking.delete({ where: { id: markingId } }));
}
