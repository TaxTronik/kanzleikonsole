// =============================================================================
// Rechtsnorm-Kuratierung pro Markierung — Persistenz + Audit (tenant-scoped, RLS).
//
// Die reine Logik liegt in `norms-core.ts` (ohne DB-Import, direkt testbar); hier
// nur die DB-/Audit-Hülle. Die von der Engine vorgeschlagenen Rechtsnormen sind
// NICHT verbindlich — der Berufsträger kuratiert sie pro Fall (eigene ergänzen,
// Engine-Vorschläge soft verwerfen). `normAnker` wird auf die EFFEKTIVE (nicht
// verworfene) Zitatliste synchron gehalten (treibt Recherche-Heuristik + Export).
// Jede Mutation wird im selben Tx in der TaxTronik-Hash-Chain verankert.
//
// Anschlusspunkt (geschichtet): „In Katalog übernehmen" macht eine Begriffs-Karte
// dauerhaft besser — via künftigem Engine-Katalog-Endpoint, ebenfalls hier
// auditiert (die Engine bleibt audit-frei). Seam dafür: marking.begriffId.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  type CuratedNormRef,
  type NormTarget,
  readNormRefs,
  effectiveAnker,
  applyAddBerater,
  applyVerworfen,
  applyRemoveBerater,
} from './norms-core';

// Reine Logik + Typen + Fehler unter @/server/risk verfügbar machen.
export * from './norms-core';

/** Lädt die aktuellen Norm-Refs, wendet eine Mutation an, schreibt normRefs +
 *  effektive normAnker zurück und verankert before/after in der Hash-Chain. */
async function persistNorms(
  ctx: TenantContext,
  markingId: string,
  mutate: (refs: CuratedNormRef[]) => CuratedNormRef[],
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const before = await tx.riskMarking.findUnique({
      where: { id: markingId },
      select: { normRefs: true, normAnker: true },
    });
    if (!before) throw new Error('Markierung nicht gefunden.');

    const current = readNormRefs(before.normRefs, before.normAnker);
    const next = mutate(current);
    const anker = effectiveAnker(next);

    await tx.riskMarking.update({
      where: { id: markingId },
      data: { normRefs: next as unknown as object, normAnker: anker },
    });

    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.marking.norms_curated',
      resourceType: 'risk_marking',
      resourceId: markingId,
      before: { normRefs: current, normAnker: before.normAnker },
      after: { normRefs: next, normAnker: anker },
    });
  });
}

export function addBeraterNorm(
  ctx: TenantContext,
  markingId: string,
  input: { zitat: string; id?: string | null; titel?: string | null },
): Promise<void> {
  return persistNorms(ctx, markingId, (refs) => applyAddBerater(refs, input));
}

export function setNormVerworfen(
  ctx: TenantContext,
  markingId: string,
  target: NormTarget,
  verworfen: boolean,
): Promise<void> {
  return persistNorms(ctx, markingId, (refs) => applyVerworfen(refs, target, verworfen));
}

export function removeBeraterNorm(
  ctx: TenantContext,
  markingId: string,
  target: NormTarget,
): Promise<void> {
  return persistNorms(ctx, markingId, (refs) => applyRemoveBerater(refs, target));
}
