// =============================================================================
// Analyse-Orchestrierung (Zwei-Phasen).
//
// `runDeterministicAnalysis` = schnell (mitLLM:false) für die sofortige UX;
// `runLlmAnalysis` = LLM-Schicht (15–30 s) für die zweite Phase. Beide rufen die
// Engine über @taxtronik/risk-layer und persistieren via saveAnalysis.
//
// Der Client ist injizierbar (Tests) — Default: ein frischer RiskLayerClient
// (liest URL/Token aus @taxtronik/config; wirft RiskLayerNotConfiguredError,
// wenn die Engine nicht deployt ist).
// =============================================================================

import { RiskLayerClient, type RiskAnalysisResult } from '@taxtronik/risk-layer';
import type { TenantContext } from '@taxtronik/db';
import { saveAnalysis } from './persistence';

/** Minimaler Client-Vertrag für DI/Tests. */
export type AnalyseCapableClient = Pick<RiskLayerClient, 'analyse'>;

export interface RunAnalysisInput {
  text: string;
  /** StaffUser, der die Analyse auslöst. */
  staffId: string;
  clientId?: string | null;
  documentId?: string | null;
  optionen?: Record<string, unknown>;
}

export interface RunAnalysisOutput {
  analysisId: string;
  markingCount: number;
  result: RiskAnalysisResult;
}

async function run(
  ctx: TenantContext,
  input: RunAnalysisInput,
  mitLLM: boolean,
  client?: AnalyseCapableClient,
): Promise<RunAnalysisOutput> {
  const c = client ?? new RiskLayerClient();
  const result = await c.analyse({ text: input.text, mitLLM, optionen: input.optionen });
  const saved = await saveAnalysis(ctx, {
    result,
    clientId: input.clientId ?? null,
    documentId: input.documentId ?? null,
    createdById: input.staffId,
  });
  return { ...saved, result };
}

/** Phase 1: schnell/deterministisch (ohne LLM). */
export function runDeterministicAnalysis(
  ctx: TenantContext,
  input: RunAnalysisInput,
  client?: AnalyseCapableClient,
): Promise<RunAnalysisOutput> {
  return run(ctx, input, false, client);
}

/** Phase 2: mit LLM-Schicht (langsam). Gehört perspektivisch in einen Worker-Job. */
export function runLlmAnalysis(
  ctx: TenantContext,
  input: RunAnalysisInput,
  client?: AnalyseCapableClient,
): Promise<RunAnalysisOutput> {
  return run(ctx, input, true, client);
}
