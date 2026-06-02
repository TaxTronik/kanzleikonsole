// =============================================================================
// Report-Modell für den Subsumtions-Export (annotierter Sachverhalt + Tabelle).
//
// Format-neutral: lädt die Analyse + Markierungen tenant-scoped und baut ein
// strukturiertes Modell. Die Renderer (to-docx, to-pdf) hängen NUR an diesem
// Modell — kein DB-/Format-Wissen doppelt.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';

export interface ReportMarking {
  begriff: string;
  herkunftLabel: string;
  herkunftColor: string; // #rrggbb
  engineStatusLabel: string | null;
  streitig: boolean;
  normAnker: string[];
  governanceLabel: string | null;
  schadenLabel: string | null;
  wahrscheinlichkeitLabel: string | null;
  statusLabel: string;
  kontrolle: string | null;
  notiz: string | null;
  start: number;
  end: number;
}

export interface ReportSegment {
  text: string;
  /** Gesetzt → Stelle ist markiert (Farbe/Streit der überdeckenden Markierung). */
  color: string | null;
  streitig: boolean;
}

export interface ReportModel {
  title: string;
  clientName: string | null;
  createdAt: Date;
  textHash: string;
  katalogVersion: string;
  engineVersion: string;
  llmEnriched: boolean;
  sourceText: string;
  segments: ReportSegment[];
  markings: ReportMarking[];
  /** Zähler nach engineStatus/Herkunft für die Kopfzeile. */
  counts: { gesamt: number; eigen: number };
}

const HERKUNFT_LABEL: Record<string, string> = {
  WOERTLICH: 'wörtlich', MUSTER: 'Muster', TRIGGER: 'Trigger',
  EMBEDDING: 'Heuristik', LLM: 'LLM', BERATER: 'Berater',
};
const HERKUNFT_COLOR: Record<string, string> = {
  WOERTLICH: '#10b981', MUSTER: '#3b82f6', TRIGGER: '#0ea5e9',
  EMBEDDING: '#f59e0b', LLM: '#f97316', BERATER: '#14b8a6',
};
const STATUS_LABEL: Record<string, string> = {
  OFFEN: 'Offen', IN_PRUEFUNG: 'In Prüfung', KONTROLLIERT: 'Kontrolliert', AKZEPTIERT: 'Akzeptiert',
};
const GOV_LABEL: Record<string, string> = {
  FP: 'Festsetzung (FP)', FF: 'Feststellung (FF)', IN: 'Information (IN)',
};
const STUFE_LABEL: Record<string, string> = { NIEDRIG: 'Niedrig', MITTEL: 'Mittel', HOCH: 'Hoch' };
const WK_LABEL: Record<string, string> = {
  SELTEN: 'Selten', MOEGLICH: 'Möglich', WAHRSCHEINLICH: 'Wahrscheinlich', HAEUFIG: 'Häufig',
};
const ENGINE_STATUS_LABEL: Record<string, string> = {
  treffer: 'Treffer', luecke: 'Lücke', kandidat: 'Kandidat',
  unknown_risiko: 'Unknown-Risiko', berater: 'Berater-Definition',
};

const STREIT_COLOR = '#ef4444';

/** Text + Markierungen → nicht überlappende Segmente (kleinste überdeckende gewinnt). */
function buildSegments(
  text: string,
  markings: Array<{ start: number; end: number; color: string; streitig: boolean }>,
): ReportSegment[] {
  if (markings.length === 0) return [{ text, color: null, streitig: false }];
  const bounds = new Set<number>([0, text.length]);
  for (const m of markings) {
    bounds.add(Math.max(0, Math.min(text.length, m.start)));
    bounds.add(Math.max(0, Math.min(text.length, m.end)));
  }
  const points = [...bounds].sort((a, b) => a - b);
  const segs: ReportSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    let top: { start: number; end: number; color: string; streitig: boolean } | null = null;
    for (const m of markings) {
      if (m.start <= a && m.end >= b) {
        if (!top || m.end - m.start < top.end - top.start) top = m;
      }
    }
    segs.push({ text: text.slice(a, b), color: top ? top.color : null, streitig: top?.streitig ?? false });
  }
  return segs;
}

export async function buildReportModel(ctx: TenantContext, analysisId: string): Promise<ReportModel | null> {
  return withTenantContext(ctx, async (tx) => {
    const a = await tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        markings: { orderBy: { start: 'asc' } },
        client: { select: { name: true } },
      },
    });
    if (!a) return null;

    const markings: ReportMarking[] = a.markings.map((m) => ({
      begriff: m.begriff,
      herkunftLabel: HERKUNFT_LABEL[m.herkunft] ?? m.herkunft,
      herkunftColor: HERKUNFT_COLOR[m.herkunft] ?? '#6b7280',
      engineStatusLabel: m.engineStatus ? (ENGINE_STATUS_LABEL[m.engineStatus] ?? m.engineStatus) : null,
      streitig: m.streitig,
      normAnker: m.normAnker,
      governanceLabel: m.governanceTyp ? (GOV_LABEL[m.governanceTyp] ?? m.governanceTyp) : null,
      schadenLabel: m.schadensintensitaet ? (STUFE_LABEL[m.schadensintensitaet] ?? m.schadensintensitaet) : null,
      wahrscheinlichkeitLabel: m.wahrscheinlichkeit ? (WK_LABEL[m.wahrscheinlichkeit] ?? m.wahrscheinlichkeit) : null,
      statusLabel: STATUS_LABEL[m.status] ?? m.status,
      kontrolle: m.kontrolle,
      notiz: m.notiz,
      start: m.start,
      end: m.end,
    }));

    const segments = buildSegments(
      a.sourceText,
      a.markings.map((m) => ({
        start: m.start,
        end: m.end,
        color: m.streitig ? STREIT_COLOR : (HERKUNFT_COLOR[m.herkunft] ?? '#6b7280'),
        streitig: m.streitig,
      })),
    );

    return {
      title: a.title || 'Subsumtion',
      clientName: a.client?.name ?? null,
      createdAt: a.createdAt,
      textHash: a.textHash,
      katalogVersion: a.katalogVersion,
      engineVersion: a.engineVersion,
      llmEnriched: a.llmEnrichedAt != null,
      sourceText: a.sourceText,
      segments,
      markings,
      counts: {
        gesamt: a.markings.length,
        eigen: a.markings.filter((m) => m.herkunft === 'BERATER').length,
      },
    };
  });
}

export const DISCLAIMER =
  'Das System lenkt Aufmerksamkeit, es übernimmt keine Subsumtion. Markierungen sind Hinweise auf ' +
  'definitions- und subsumtionsbedürftige Stellen — keine Rechtsfolgenbestimmung. Die Bewertung ' +
  'schuldet der Berufsträger höchstpersönlich (§§ 33, 57 StBerG).';
