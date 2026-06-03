// =============================================================================
// Katalog-weite Norm-Kuratierung (geschichtete Promotion oben auf der per-Fall-
// Kuratierung in norms.ts). Eine Begriffs-Karte wird dauerhaft besser: der Berater
// verwirft/ergänzt eine Norm KATALOGWEIT → wirkt auf künftige Analysen dieses
// Begriffs (`POST /v1/katalog/norm_kuratieren`).
//
// Invarianten: Begriff-scoped (kein Falltext → §203, fallzustandslos). Die Engine
// hält nur den Katalog-STATE; die Kuratierungs-HANDLUNG wird in TaxTronik
// auditiert (die Engine führt KEIN Audit — §4-Härtung). Nur Karten mit echtem
// `begriffId` (Trigger/LLM/manuell → per-Fall in norms.ts).
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { RiskLayerClient } from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';

export type NormKuratierAktion = 'verwerfen' | 'ergaenzen' | 'zuruecksetzen';
export type NormKuratierScope = 'personal' | 'geteilt';

/** Minimaler Client-Vertrag für DI/Tests. */
export type KatalogKuratierClient = Pick<RiskLayerClient, 'katalogNormKuratieren'>;

export class NotACatalogMarkingError extends Error {
  constructor() {
    super('Katalog-Kuratierung ist nur für Begriffs-Karten möglich (Trigger-/LLM-/eigene Markierungen werden pro Fall kuratiert).');
    this.name = 'NotACatalogMarkingError';
  }
}

export class CatalogCurationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogCurationFailedError';
  }
}

export interface KuratiereKatalogNormInput {
  markingId: string;
  norm: string;
  aktion: NormKuratierAktion;
  scope: NormKuratierScope;
  /** Urheber-Tag (StaffUser-ID) — für personal-Scope + Provenienz in der Engine. */
  autor: string;
}

/**
 * Kuratiert eine Norm der Begriffs-Karte katalogweit + verankert die Handlung in
 * der Hash-Chain. Reihenfolge: begriffId lesen (kurze Tx) → Engine-Call (außerhalb
 * jeder Tx) → bei Erfolg Audit (Tx). Scheitert die Engine, wird NICHT auditiert.
 */
export async function kuratiereKatalogNorm(
  ctx: TenantContext,
  input: KuratiereKatalogNormInput,
  client?: KatalogKuratierClient,
): Promise<void> {
  const marking = await withTenantContext(ctx, (tx) =>
    tx.riskMarking.findUnique({ where: { id: input.markingId }, select: { begriffId: true } }),
  );
  if (!marking) throw new Error('Markierung nicht gefunden.');
  if (!marking.begriffId) throw new NotACatalogMarkingError();
  const katalogId = marking.begriffId;

  const c = client ?? new RiskLayerClient();
  const res = await c.katalogNormKuratieren({
    katalogId,
    norm: input.norm,
    aktion: input.aktion,
    scope: input.scope,
    autor: input.autor,
  });
  if (!res.ok) throw new CatalogCurationFailedError(res.fehler || 'Die Katalog-Kuratierung ist fehlgeschlagen.');

  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.catalog.norm_curated',
      resourceType: 'risk_catalog',
      resourceId: katalogId,
      after: { markingId: input.markingId, katalogId, norm: input.norm, aktion: input.aktion, scope: input.scope },
    }),
  );
}
