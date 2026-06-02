// =============================================================================
// Katalog-Rückfluss: Berater-Definition an die Engine pushen (define-on-the-fly).
//
// Schließt den „kollaborativen Zusammenbau"-Kreis (Requirement C/D): wenn aus
// einer delegierten Recherche eine belastbare Definition entsteht, wird sie via
// `POST /v1/katalog/definiere` in den (engine-kanonischen) Katalog geschrieben
// und die Markierung referenziert den neuen Begriff. Persistiert wird in der
// Engine (5.1: Engine kanonisch, API-only) — TaxTronik hält nur die Verknüpfung.
// =============================================================================

import { RiskLayerClient } from '@taxtronik/risk-layer';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

/** Minimaler Client-Vertrag für DI/Tests. */
export type DefineCapableClient = Pick<RiskLayerClient, 'katalogDefiniere'>;

export interface PushDefinitionInput {
  /** Markierung, deren Recherche die Definition hervorgebracht hat. */
  markingId: string;
  begriff: string;
  definition: string;
  normAnker?: string[];
  scope?: string;
}

export interface PushDefinitionResult {
  begriffId: string;
  scope: string;
}

export async function pushDefinitionToCatalog(
  ctx: TenantContext,
  input: PushDefinitionInput,
  client?: DefineCapableClient,
): Promise<PushDefinitionResult> {
  const c = client ?? new RiskLayerClient();
  const res = await c.katalogDefiniere({
    begriff: input.begriff,
    definition: input.definition,
    normAnker: input.normAnker,
    scope: input.scope,
  });

  // Den neu angelegten Katalog-Begriff an die Markierung zurückbinden. Die
  // Provenienz (herkunft) bleibt unverändert — sie beschreibt, WIE die Stelle
  // erkannt wurde, nicht wer den Begriff kuratiert hat.
  await withTenantContext(ctx, async (tx) => {
    await tx.riskMarking.update({
      where: { id: input.markingId },
      data: { begriffId: res.begriffId },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.catalog.defined',
      resourceType: 'risk_marking',
      resourceId: input.markingId,
      after: { begriff: input.begriff, begriffId: res.begriffId, scope: res.scope },
    });
  });

  return res;
}
