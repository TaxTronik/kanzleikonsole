// Gemeinsame Typen + Label-/Farb-Maps für den Subsumtions-Workspace.

export type Herkunft = 'WOERTLICH' | 'MUSTER' | 'TRIGGER' | 'EMBEDDING' | 'LLM' | 'BERATER';
export type GovernanceTyp = 'FP' | 'FF' | 'IN';
export type RiskStufe = 'NIEDRIG' | 'MITTEL' | 'HOCH';
export type RiskWk = 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG';
export type RiskStatus = 'OFFEN' | 'IN_PRUEFUNG' | 'KONTROLLIERT' | 'AKZEPTIERT';

/** Norm-Referenz mit stabiler Engine-ID (für das Gesetzestext-Expandable). Die
 *  Engine-Norm ist NICHT verbindlich: der Berater kann eigene Normen ergänzen
 *  (`quelle:'BERATER'`) und Engine-Vorschläge verwerfen (`verworfen:true`, soft —
 *  bleibt zur Provenienz erhalten, zählt aber nicht zur effektiven Normliste).
 *  Fehlende `quelle` = Engine-Vorschlag (Abwärtskompatibilität mit Altdaten). */
export interface NormRefDTO {
  zitat: string;
  id: string | null;
  titel: string | null;
  quelle?: 'ENGINE' | 'BERATER';
  verworfen?: boolean;
}

export interface MarkingDTO {
  id: string;
  start: number;
  end: number;
  matchedText: string;
  herkunft: Herkunft;
  engineStatus: string | null;
  streitig: boolean;
  begriffId: string | null;
  begriff: string;
  normAnker: string[];
  normRefs: NormRefDTO[] | null;
  normketten: unknown;
  governanceTyp: GovernanceTyp | null;
  schadensintensitaet: RiskStufe | null;
  wahrscheinlichkeit: RiskWk | null;
  kaskadenreichweite: number | null;
  kontrolle: string | null;
  status: RiskStatus;
  notiz: string | null;
  verantwortlichId: string | null;
  farbe: string | null;
  label: string | null;
}

export interface AnalysisDTO {
  id: string;
  sourceText: string;
  title: string | null;
  textHash: string;
  /** Formatierter Sachverhalt (Tiptap-JSON) oder null (Alt-Analyse → Plaintext). */
  sourceDoc: unknown;
  llmEnrichedAt: string | null;
  archivedAt: string | null;
  markings: MarkingDTO[];
}

export interface ResearchResultDTO {
  id: string;
  title: string | null;
  body: string;
  status: 'NEU' | 'ZUGEORDNET' | 'VERWORFEN';
  markingId: string | null;
  source: string | null;
  receivedAt: string;
  /** Heuristische Markierungs-Vorschläge (nur für NEU). */
  suggestions: Array<{ markingId: string; begriff: string; score: number; reason: string }>;
}

/** Ein gesendeter Rechercheauftrag (Outbound an n8n) — für den Recherche-Hub. */
export interface ResearchRequestDTO {
  id: string;
  markingId: string | null;
  /** Begriff der Markierung (lesbares Label) oder null = ganzer Fall. */
  begriff: string | null;
  prompt: string | null;
  includeSachverhalt: boolean;
  status: 'SENT' | 'ANSWERED' | 'FAILED';
  createdAt: string;
  createdById: string;
  /** Anzahl bisher zurückgekommener Ergebnisse. */
  resultCount: number;
}

export const HERKUNFT_LABEL: Record<Herkunft, string> = {
  WOERTLICH: 'wörtlich',
  MUSTER: 'Muster',
  TRIGGER: 'Trigger',
  EMBEDDING: 'Heuristik',
  LLM: 'LLM',
  BERATER: 'Berater',
};

export const STATUS_LABEL: Record<RiskStatus, string> = {
  OFFEN: 'Offen',
  IN_PRUEFUNG: 'In Prüfung',
  KONTROLLIERT: 'Kontrolliert',
  AKZEPTIERT: 'Akzeptiert',
};

export const GOV_LABEL: Record<GovernanceTyp, string> = {
  FP: 'Festsetzung (FP)',
  FF: 'Feststellung (FF)',
  IN: 'Information (IN)',
};

export const ENGINE_STATUS_LABEL: Record<string, string> = {
  treffer: 'Treffer',
  luecke: 'Lücke',
  kandidat: 'Kandidat',
  unknown_risiko: 'Unknown-Risiko',
  berater: 'Berater-Definition',
};

// --- Katalog-Overlay (katalogweiter Kuratierungszustand eines Begriffs) -------
// Read-Seite (GET /v1/katalog/kuratierung): überlagert die Norm-Liste, damit der
// Berater katalogweit-kuratierte Normen von per-Fall-Edits unterscheiden kann.

export interface KatalogOverlay {
  /** Katalogweit verworfene Norm-IDs. */
  verworfen: Set<string>;
  ergaenztIds: Set<string>;
  ergaenztZitate: Set<string>;
}

export function buildKatalogOverlay(view: {
  verworfen: string[];
  ergaenzt: Array<{ zitat: string; id: string | null }>;
}): KatalogOverlay {
  return {
    verworfen: new Set(view.verworfen),
    ergaenztIds: new Set(view.ergaenzt.map((e) => e.id).filter((x): x is string => !!x)),
    ergaenztZitate: new Set(view.ergaenzt.map((e) => e.zitat)),
  };
}

/** Katalogweiter Status einer Norm: verworfen / ergaenzt / null (kein Eintrag). */
export function katalogStatus(
  ref: { id: string | null; zitat: string },
  overlay: KatalogOverlay | null,
): 'verworfen' | 'ergaenzt' | null {
  if (!overlay) return null;
  if (ref.id && overlay.verworfen.has(ref.id)) return 'verworfen';
  if ((ref.id && overlay.ergaenztIds.has(ref.id)) || overlay.ergaenztZitate.has(ref.zitat)) return 'ergaenzt';
  return null;
}

/** Anzeige-Filter: 6 Herkünfte + Streit. */
export const FILTER_KEYS = [
  'WOERTLICH',
  'MUSTER',
  'TRIGGER',
  'LLM',
  'EMBEDDING',
  'BERATER',
  'STREIT',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTER_LABEL: Record<FilterKey, string> = {
  WOERTLICH: 'wörtlich',
  MUSTER: 'Muster',
  TRIGGER: 'Trigger',
  LLM: 'LLM',
  EMBEDDING: 'Heuristik',
  BERATER: 'Berater',
  STREIT: 'Streit',
};

/** Eine Markierung ist sichtbar, wenn ihre Herkunft aktiv ist und — falls
 *  streitig — der Streit-Filter aktiv ist. */
export function isVisible(m: MarkingDTO, active: Set<FilterKey>): boolean {
  if (!active.has(m.herkunft)) return false;
  if (m.streitig && !active.has('STREIT')) return false;
  return true;
}

// Unterstreichungs-Farbe (Hex) je Herkunft — als Inline-Style angewandt, damit
// wir nicht von der Verfügbarkeit dynamischer Tailwind-Color-Utilities abhängen.
const HERKUNFT_COLOR: Record<Herkunft, string> = {
  WOERTLICH: '#10b981', // emerald
  MUSTER: '#3b82f6', // blue
  TRIGGER: '#0ea5e9', // sky
  EMBEDDING: '#f59e0b', // amber
  LLM: '#f97316', // orange
  BERATER: '#14b8a6', // teal
};

/** Punktfarbe (Hex) je Herkunft — für Legende/Chips. */
export function herkunftColor(h: Herkunft): string {
  return HERKUNFT_COLOR[h];
}

/** Badge-Klasse je Herkunft (für Panel-Badges; nur vorhandene Klassen). */
export function herkunftBadge(h: Herkunft): string {
  const map: Record<Herkunft, string> = {
    WOERTLICH: 'badge-green',
    MUSTER: 'badge-brand',
    TRIGGER: 'badge-brand',
    EMBEDDING: 'badge-yellow',
    LLM: 'badge-yellow',
    BERATER: 'badge-purple',
  };
  return map[h] ?? 'badge-gray';
}

