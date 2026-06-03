// =============================================================================
// Neu analysieren (zusammenführend, nicht-destruktiv).
//
// Lässt die Engine erneut DETERMINISTISCH (mitLLM:false) auf den gespeicherten
// Sachverhalt laufen und ergänzt NUR neue Markierungen (Dedup über
// start:end:herkunft:begriff — wie die LLM-Phase). Bestehende Markierungen samt
// Bewertungen/Notizen/Zuweisungen sowie eigene (Berater-)Markierungen bleiben
// unangetastet. Nützlich z. B. nach einem Katalog-Update der Engine.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { RiskLayerClient } from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { markingKey, markingCreateFields } from './marking-data';

/** Minimaler Client-Vertrag für DI/Tests. */
export type ReanalyzeClient = Pick<RiskLayerClient, 'analyse'>;

export interface ReanalyzeResult {
  added: number;
  total: number;
}

export async function reanalyzeAnalysis(
  ctx: TenantContext,
  analysisId: string,
  client?: ReanalyzeClient,
): Promise<ReanalyzeResult> {
  // sourceText aus der gespeicherten Analyse (NICHT vom Client) — der erneute Lauf
  // muss auf demselben Text aufsetzen, damit die Offsets passen.
  const analysis = await withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findUnique({ where: { id: analysisId }, select: { sourceText: true } }),
  );
  if (!analysis) throw new Error('Analyse nicht gefunden.');

  const c = client ?? new RiskLayerClient();
  const result = await c.analyse({ text: analysis.sourceText, mitLLM: false });

  return withTenantContext(ctx, async (tx) => {
    const existing = await tx.riskMarking.findMany({
      where: { analysisId },
      select: { start: true, end: true, herkunft: true, begriff: true },
    });
    const existingKeys = new Set(existing.map(markingKey));
    const fresh = result.markings.filter((m) => !existingKeys.has(markingKey(m)));

    if (fresh.length > 0) {
      await tx.riskMarking.createMany({
        data: fresh.map((m) => ({ tenantId: ctx.tenantId, analysisId, ...markingCreateFields(m) })),
      });
    }

    // Katalog-/Engine-Version auf den frischen Lauf nachziehen (reflektiert, womit
    // zuletzt analysiert wurde) — Offsets/sourceText bleiben unverändert.
    await tx.riskAnalysis.update({
      where: { id: analysisId },
      data: { katalogVersion: result.katalogVersion, engineVersion: result.engineVersion },
    });

    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.analysis.reanalyzed',
      resourceType: 'risk_analysis',
      resourceId: analysisId,
      after: {
        added: fresh.length,
        total: result.markings.length,
        katalogVersion: result.katalogVersion,
        engineVersion: result.engineVersion,
      },
    });

    log.info({ component: 'risk', analysisId, added: fresh.length, total: result.markings.length }, 'risk: neu analysiert (zusammenführend)');
    return { added: fresh.length, total: result.markings.length };
  });
}
