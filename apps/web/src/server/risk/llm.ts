// =============================================================================
// LLM-Status (Schicht 2) für die UI. Liest GET /v1/llm/status und liefert ein
// schlankes DTO (Verfügbarkeit + Queue-Auslastung), damit der Workspace anzeigen
// kann, ob „Mit KI vertiefen" sofort läuft oder das Modell erst lädt.
//
// Das eigentliche Hochfahren/Pollen orchestriert der Worker-Job (on-demand beim
// „Mit KI vertiefen") — hier NUR Lesen, kein Start.
// =============================================================================

import { RiskLayerClient } from '@taxtronik/risk-layer';

/** Minimaler Client-Vertrag für DI/Tests. */
export type LlmStatusClient = Pick<RiskLayerClient, 'llmStatus'>;

export interface LlmStatusDTO {
  verfuegbar: boolean;
  modellGeladen: boolean | null;
  binaryVorhanden: boolean | null;
  vonUnsGestartet: boolean | null;
  /** Ausführungsweg der generativen Schicht; managed/One-Click setzt `cpu`. */
  backend: string | null;
  /** Signal meldet damit einen funktionalen, aber erwartbar langsamen Pfad. */
  performanceBottleneck: boolean;
  /** Queue-Auslastung des llama-server oder null (nicht gelaufen / nicht exponiert). */
  queue: {
    quelle: string | null;
    slotsGesamt: number | null;
    aktiv: number | null;
    frei: number | null;
    wartend: number | null;
  } | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export async function getLlmStatus(client?: LlmStatusClient): Promise<LlmStatusDTO> {
  const c = client ?? new RiskLayerClient();
  const s = await c.llmStatus();
  const q = s.queue ?? null;
  const backend =
    typeof s.backend === 'string'
      ? s.backend
      : typeof process.env.RISK_LAYER_LLM_BACKEND === 'string'
        ? process.env.RISK_LAYER_LLM_BACKEND
        : null;
  return {
    verfuegbar: s.verfuegbar,
    modellGeladen: bool(s.modell_geladen),
    binaryVorhanden: bool(s.binary_vorhanden),
    vonUnsGestartet: bool(s.von_uns_gestartet),
    backend,
    performanceBottleneck: bool(s.performance_bottleneck) ?? backend?.toLowerCase() === 'cpu',
    queue: q
      ? {
          quelle: typeof q.quelle === 'string' ? q.quelle : null,
          slotsGesamt: num(q.slots_gesamt),
          aktiv: num(q.aktiv),
          frei: num(q.frei),
          wartend: num(q.wartend),
        }
      : null,
  };
}
