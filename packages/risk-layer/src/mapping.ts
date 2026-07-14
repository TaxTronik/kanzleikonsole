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

/**
 * Norm-Referenz, flach normalisiert über beide Engine-Varianten (Karte `ids[]`
 * vs. Risiko `id`). `id` ist der Schlüssel für `/v1/normgraph/aufloesen` (lädt den
 * Gesetzestext on demand); `titel` ist die Norm-Überschrift, sofern mitgeliefert.
 */
export interface NormRef {
  zitat: string;
  id: string | null;
  titel: string | null;
  /** Provenienz der Katalog-Kuratierung: ENGINE = Standardvorschlag, BERATER =
   *  katalogweit ergänzt. (Engine-Vokabular „katalog"/„berater" → hier übersetzt.) */
  quelle: 'ENGINE' | 'BERATER';
  /** Vom Berater katalogweit verworfener Vorschlag (zählt nicht zur effektiven Liste). */
  verworfen: boolean;
}

/** Eine zur Persistenz fertige Markierung (vor Berater-Bearbeitung). */
export interface RiskMarkingInput {
  start: number;
  end: number;
  matchedText: string;
  herkunft: RiskHerkunft;
  begriffId: string | null;
  begriff: string;
  normAnker: string[];
  /** Norm-Referenzen mit stabiler ID + Titel (für das Norm-Expandable). */
  normRefs: NormRef[];
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
  /** Unveränderter Engine-Output für Audit/Replay (App legt ihn gzip im Object-
   *  Store ab, nicht in Postgres — Referenz auf RiskAnalysis.rawResultKey). */
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
 * Leitet die Vertrauensstufe ab. Reihenfolge der Signalstärke:
 *   1. `methode`/`quelle` (explizit von der Engine) — am verlässlichsten,
 *   2. `via` (nur Karten tragen es),
 *   3. `schicht` als Fallback NUR für deterministische Schichten.
 *
 * Wichtig: Die LLM-Schicht trägt `schicht:"2"`, aber `methode:"llm"`/`quelle:
 * "llm"`. Würde man (wie früher) `schicht "2" → EMBEDDING` zuerst auswerten,
 * landeten LLM-Treffer fälschlich als „Heuristik". Daher `methode`/`quelle`
 * VOR der Schicht. Wirft NICHT — unbekannte Provenienz fällt auf `fallback`.
 */
function deriveHerkunft(opts: {
  via?: string | null;
  schicht?: string | number | null;
  quelle?: string | null;
  methode?: string | null;
  fallback: RiskHerkunft;
}): RiskHerkunft {
  const m = (opts.methode ?? '').toString().toLowerCase();
  const q = (opts.quelle ?? '').toString().toLowerCase();
  const v = (opts.via ?? '').toString().toLowerCase();

  // 1. Explizite Methode/Quelle — stärkstes Signal.
  if (m.includes('llm') || q === 'llm') return 'LLM';
  if (m.includes('embedding') || m.includes('semant') || q === 'embedding' || q === 'semantik')
    return 'EMBEDDING';

  // 2. via (Karten).
  if (v.includes('wörtlich') || v.includes('woertlich') || v.includes('woert')) return 'WOERTLICH';
  if (v.includes('muster')) return 'MUSTER';
  if (v.includes('trigger')) return 'TRIGGER';
  if (v.includes('embedding') || v.includes('semant') || v.includes('vektor')) return 'EMBEDDING';
  if (v.includes('llm') || v.includes('modell') || v === 'ki') return 'LLM';

  // quelle der Risiken: trigger/streit sind deterministische Hinweis-Schichten.
  if (q === 'trigger' || q === 'streit') return 'TRIGGER';

  // 3. schicht-Fallback. 1 = wörtlich, 1.5 = trigger. 2/3 nur, wenn KEINE
  // explizite Methode vorlag (oben sonst schon abgefangen) — konservativ.
  const s = (opts.schicht ?? '').toString().toLowerCase();
  if (s.startsWith('1.5')) return 'TRIGGER';
  if (s.startsWith('1')) return 'WOERTLICH';
  if (s.startsWith('3')) return 'LLM';
  if (s.startsWith('2')) return 'EMBEDDING';

  return opts.fallback;
}

/**
 * Eine Stelle ist streitig, wenn die Engine das Boolean setzt ODER ein
 * textuelles Streitsignal liefert ("streitig"/"umstritten"/"fraglich" …).
 * Beide Felder werden befüllt; manche Stellen tragen nur das Signal — ohne
 * dieses würden sie nicht über „Streit" markiert.
 */
function isStreitig(x: { ist_streitig?: boolean | null; streit_signal?: string | null }): boolean {
  return (
    x.ist_streitig === true ||
    (typeof x.streit_signal === 'string' && x.streit_signal.trim() !== '')
  );
}

/**
 * Normalisiert die beiden Engine-Varianten (`id` vs. `ids[]`) auf flache
 * NormRefs. Leere/zitatlose Einträge fallen raus.
 */
function toNormRefs(
  refs: Array<{
    zitat: string;
    id?: string | null;
    ids?: string[] | null;
    titel?: string | null;
    quelle?: string | null;
    verworfen?: boolean | null;
  }>,
): NormRef[] {
  return refs
    .filter((r) => r.zitat && r.zitat.length > 0)
    .map((r) => ({
      zitat: r.zitat,
      id: r.id ?? r.ids?.[0] ?? null,
      titel: r.titel ?? null,
      // Engine-Vokabular → TaxTronik-Provenienz (alles außer "berater" = ENGINE).
      quelle: r.quelle === 'berater' ? 'BERATER' : 'ENGINE',
      verworfen: r.verworfen === true,
    }));
}

function mapKarte(k: Karte): RiskMarkingInput {
  const refs = toNormRefs(k.norm_anker);
  return {
    start: k.start,
    end: k.end,
    matchedText: k.matched_text,
    herkunft: deriveHerkunft({
      via: k.via,
      schicht: k.herkunft?.schicht,
      methode: k.herkunft?.methode,
      fallback: 'MUSTER',
    }),
    begriffId: k.begriff_id ?? null,
    begriff: k.begriff || k.matched_text,
    // Effektive Liste (katalogweit verworfene Vorschläge ausgenommen) — treibt
    // Recherche-Heuristik + Export; volle Provenienz steckt in normRefs.
    normAnker: refs.filter((r) => !r.verworfen).map((r) => r.zitat),
    normRefs: refs,
    normketten: k.normketten ?? null,
    governanceTyp: lookup(GOVERNANCE, k.governance_typ),
    schadensintensitaet: lookup(STUFE, k.schadensintensitaet),
    wahrscheinlichkeit: lookup(WK, k.wahrscheinlichkeit),
    kaskadenreichweite: k.kaskadenreichweite ?? null,
    engineStatus: k.status ?? null,
    streitig: isStreitig(k),
  };
}

function mapRisiko(r: Risiko): RiskMarkingInput {
  // Risiken tragen oft (noch) keinen festen Normanker, aber Vorschläge.
  const anker = r.norm_anker.length > 0 ? r.norm_anker : r.norm_vorschlag;
  const refs = toNormRefs(anker);
  return {
    start: r.start,
    end: r.end,
    matchedText: r.matched_text,
    herkunft: deriveHerkunft({
      via: r.via,
      schicht: r.herkunft?.schicht,
      methode: r.herkunft?.methode,
      quelle: r.quelle,
      fallback: 'TRIGGER',
    }),
    begriffId: null,
    begriff: r.titel || r.matched_text,
    normAnker: refs.filter((rf) => !rf.verworfen).map((rf) => rf.zitat),
    normRefs: refs,
    normketten: null,
    governanceTyp: lookup(GOVERNANCE, r.governance_typ),
    schadensintensitaet: lookup(STUFE, r.schadensintensitaet),
    wahrscheinlichkeit: lookup(WK, r.wahrscheinlichkeit),
    kaskadenreichweite: r.kaskadenreichweite ?? null,
    engineStatus: r.status ?? null,
    streitig: isStreitig(r),
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
