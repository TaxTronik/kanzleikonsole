// =============================================================================
// Domänen-Mapping: Engine-JSON → TaxTronik-Typen.
//
// Reine Transformation — kein DB-/Request-/Netzwerk-Zugriff. Normalisiert die
// deutschen Klartext-Enums der Engine auf die TaxTronik-Domänen-Enums
// (UPPERCASE, identisch zu den Prisma-Enums) und reicht die Norm-Anker/-Ketten
// erstklassig durch. Der vollständige Engine-Output bleibt als `rawResult`
// erhalten (Audit/Replay) — nichts geht verloren.
// =============================================================================

import { AnalyseResponseSchema, type EngineMarking } from './schema';

// Spiegeln die Prisma-Enums (packages/db). Bewusst dupliziert, damit das
// Transport-Paket nicht von @taxtronik/db abhängt (reiner Transport).
export type RiskHerkunft = 'WOERTLICH' | 'MUSTER' | 'TRIGGER' | 'EMBEDDING' | 'LLM' | 'BERATER';
export type GovernanceTyp = 'FP' | 'FF' | 'IN';
export type RiskStufe = 'NIEDRIG' | 'MITTEL' | 'HOCH';
export type RiskWk = 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG';

/** Eine zur Persistenz fertige Markierung (vor Berater-Bearbeitung). */
export interface RiskMarkingInput {
  start: number;
  end: number;
  matchedText: string;
  herkunft: RiskHerkunft;
  begriffId: string | null;
  begriff: string;
  normAnker: string[];
  normketten: unknown | null;
  governanceTyp: GovernanceTyp | null;
  schadensintensitaet: RiskStufe | null;
  wahrscheinlichkeit: RiskWk | null;
  kaskadenreichweite: number | null;
}

/** Ergebnis eines Analyse-Laufs, fertig für `saveAnalysis`. */
export interface RiskAnalysisResult {
  textHash: string;
  katalogVersion: string;
  engineVersion: string;
  markings: RiskMarkingInput[];
  /** Unveränderter Engine-Output für Audit/Replay (→ RiskAnalysis.rawResult). */
  rawResult: unknown;
}

/**
 * Wird geworfen, wenn ein Engine-Wert nicht auf ein Domänen-Enum abbildbar ist,
 * dessen Integrität compliance-relevant ist (Provenienz/`herkunft`). Lieber laut
 * scheitern als die Vertrauensstufe einer Markierung still verfälschen.
 */
export class RiskMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskMappingError';
  }
}

const HERKUNFT: Record<string, RiskHerkunft> = {
  woertlich: 'WOERTLICH',
  muster: 'MUSTER',
  trigger: 'TRIGGER',
  embedding: 'EMBEDDING',
  llm: 'LLM',
  berater: 'BERATER',
};
const GOVERNANCE: Record<string, GovernanceTyp> = { fp: 'FP', ff: 'FF', in: 'IN' };
const STUFE: Record<string, RiskStufe> = { niedrig: 'NIEDRIG', mittel: 'MITTEL', hoch: 'HOCH' };
const WK: Record<string, RiskWk> = {
  selten: 'SELTEN',
  moeglich: 'MOEGLICH',
  wahrscheinlich: 'WAHRSCHEINLICH',
  haeufig: 'HAEUFIG',
};

function normHerkunft(raw: string): RiskHerkunft {
  const v = HERKUNFT[raw.trim().toLowerCase()];
  if (!v) {
    throw new RiskMappingError(
      `Unbekannte Provenienz (herkunft) aus der Engine: "${raw}". ` +
        `Erlaubt: ${Object.keys(HERKUNFT).join(', ')}.`,
    );
  }
  return v;
}

/** Optionale Governance-Felder: unbekannt/leer → null (kein harter Fehler). */
function lookup<T>(table: Record<string, T>, raw: string | null | undefined): T | null {
  if (raw == null || raw === '') return null;
  return table[raw.trim().toLowerCase()] ?? null;
}

function mapMarking(m: EngineMarking): RiskMarkingInput {
  return {
    start: m.start,
    end: m.end,
    matchedText: m.matchedText,
    herkunft: normHerkunft(m.herkunft),
    begriffId: m.begriffId ?? null,
    begriff: m.begriff,
    normAnker: m.normAnker,
    normketten: m.normketten ?? null,
    governanceTyp: lookup(GOVERNANCE, m.governanceTyp),
    schadensintensitaet: lookup(STUFE, m.schadensintensitaet),
    wahrscheinlichkeit: lookup(WK, m.wahrscheinlichkeit),
    kaskadenreichweite: m.kaskadenreichweite ?? null,
  };
}

/**
 * Parst + mappt eine `/v1/analyse`-Response. Wirft `ZodError` bei kaputtem
 * Envelope, `RiskMappingError` bei unbekannter Provenienz.
 */
export function mapAnalyse(raw: unknown): RiskAnalysisResult {
  const parsed = AnalyseResponseSchema.parse(raw);
  return {
    textHash: parsed.textHash,
    katalogVersion: parsed.katalogVersion,
    engineVersion: parsed.engineVersion,
    markings: parsed.spans.map(mapMarking),
    rawResult: raw,
  };
}
