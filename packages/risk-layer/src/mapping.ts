// =============================================================================
// Domänen-Mapping: Engine-JSON → TaxTronik-Typen.
//
// Reine Transformation — kein DB-/Request-/Netzwerk-Zugriff. Die Marking-
// Substanz steckt in `karten[]` (deterministische Katalog-Treffer) und
// `risiken[]` (Trigger-/Semantik-Kandidaten); beide tragen start/end + die
// fachlichen Felder. Die Herkunft (Vertrauensstufe) leiten wir aus `via`/
// `schicht` ab. Der vollständige Engine-Output bleibt als `rawResult` erhalten.
// =============================================================================

import { AnalyseResponseSchema, type Karte, type Risiko } from './schema';

// Spiegeln die Prisma-Enums (packages/db). Bewusst dupliziert, damit das
// Transport-Paket nicht von @taxtronik/db abhängt.
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
  /** Detektionsstatus der Engine (treffer/luecke/kandidat/unknown_risiko). */
  engineStatus: string | null;
  /** Fachlich umstrittene Stelle (aus ist_streitig). */
  streitig: boolean;
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

/** Reserviert für strikte Pfade; das Standard-Mapping fällt sicher zurück. */
export class RiskMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskMappingError';
  }
}

const GOVERNANCE: Record<string, GovernanceTyp> = { fp: 'FP', ff: 'FF', in: 'IN' };
const STUFE: Record<string, RiskStufe> = { niedrig: 'NIEDRIG', mittel: 'MITTEL', hoch: 'HOCH' };
const WK: Record<string, RiskWk> = {
  selten: 'SELTEN',
  moeglich: 'MOEGLICH',
  möglich: 'MOEGLICH',
  wahrscheinlich: 'WAHRSCHEINLICH',
  haeufig: 'HAEUFIG',
  häufig: 'HAEUFIG',
};

function lookup<T>(table: Record<string, T>, raw: string | null | undefined): T | null {
  if (raw == null || raw === '') return null;
  return table[raw.trim().toLowerCase()] ?? null;
}

/**
 * Leitet die Vertrauensstufe aus `via` (primär) bzw. der `schicht` ab. Wirft
 * NICHT — eine unbekannte Provenienz fällt auf `fallback` zurück (eine einzelne
 * Markierung darf den ganzen Lauf nicht scheitern lassen).
 */
function deriveHerkunft(opts: {
  via?: string | null;
  schicht?: string | number | null;
  quelle?: string | null;
  fallback: RiskHerkunft;
}): RiskHerkunft {
  const v = (opts.via ?? '').toString().toLowerCase();
  if (v.includes('wörtlich') || v.includes('woertlich') || v.includes('woert')) return 'WOERTLICH';
  if (v.includes('muster')) return 'MUSTER';
  if (v.includes('trigger')) return 'TRIGGER';
  if (v.includes('embedding') || v.includes('semantik') || v.includes('semantisch') || v.includes('vektor'))
    return 'EMBEDDING';
  if (v.includes('llm') || v.includes('modell') || v === 'ki') return 'LLM';

  const s = (opts.schicht ?? '').toString().toLowerCase();
  if (s.startsWith('1.5')) return 'TRIGGER';
  if (s.startsWith('2')) return 'EMBEDDING';
  if (s.startsWith('3')) return 'LLM';
  if (s.startsWith('1')) return 'WOERTLICH';

  if ((opts.quelle ?? '').toString().toLowerCase() === 'trigger') return 'TRIGGER';
  return opts.fallback;
}

function zitate(refs: Array<{ zitat: string }>): string[] {
  return refs.map((r) => r.zitat).filter((z) => z.length > 0);
}

function mapKarte(k: Karte): RiskMarkingInput {
  return {
    start: k.start,
    end: k.end,
    matchedText: k.matched_text,
    herkunft: deriveHerkunft({ via: k.via, schicht: k.herkunft?.schicht, fallback: 'MUSTER' }),
    begriffId: k.begriff_id ?? null,
    begriff: k.begriff || k.matched_text,
    normAnker: zitate(k.norm_anker),
    normketten: k.normketten ?? null,
    governanceTyp: lookup(GOVERNANCE, k.governance_typ),
    schadensintensitaet: lookup(STUFE, k.schadensintensitaet),
    wahrscheinlichkeit: lookup(WK, k.wahrscheinlichkeit),
    kaskadenreichweite: k.kaskadenreichweite ?? null,
    engineStatus: k.status ?? null,
    streitig: k.ist_streitig ?? false,
  };
}

function mapRisiko(r: Risiko): RiskMarkingInput {
  // Risiken tragen oft (noch) keinen festen Normanker, aber Vorschläge.
  const anker = r.norm_anker.length > 0 ? r.norm_anker : r.norm_vorschlag;
  return {
    start: r.start,
    end: r.end,
    matchedText: r.matched_text,
    herkunft: deriveHerkunft({ via: r.via, schicht: r.herkunft?.schicht, quelle: r.quelle, fallback: 'TRIGGER' }),
    begriffId: null,
    begriff: r.titel || r.matched_text,
    normAnker: zitate(anker),
    normketten: null,
    governanceTyp: lookup(GOVERNANCE, r.governance_typ),
    schadensintensitaet: lookup(STUFE, r.schadensintensitaet),
    wahrscheinlichkeit: lookup(WK, r.wahrscheinlichkeit),
    kaskadenreichweite: r.kaskadenreichweite ?? null,
    engineStatus: r.status ?? null,
    streitig: r.ist_streitig ?? false,
  };
}

/**
 * Parst + mappt eine `/v1/analyse`-Response. Wirft `ZodError` bei kaputtem
 * Envelope. Markierungen kommen aus karten + risiken, sortiert nach Position.
 */
export function mapAnalyse(raw: unknown): RiskAnalysisResult {
  const p = AnalyseResponseSchema.parse(raw);
  const markings = [...p.karten.map(mapKarte), ...p.risiken.map(mapRisiko)].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  return {
    textHash: p.text_hash,
    katalogVersion: p.katalog_version,
    engineVersion: p.engineVersion,
    markings,
    rawResult: raw,
  };
}
