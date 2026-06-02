// =============================================================================
// Report-Modell für den Subsumtions-Export (annotierter Sachverhalt + Tabelle).
//
// Format-neutral: lädt die Analyse + Markierungen tenant-scoped und baut ein
// strukturiertes Modell. Die Renderer (to-docx, to-pdf) hängen NUR an diesem
// Modell — kein DB-/Format-Wissen doppelt.
//
// Zuordnung Text ↔ Tabelle: jede Markierung bekommt eine laufende Nr. (nach
// Position). Im Sachverhalt erscheint hinter der markierten Stelle ein Marker
// „[n]"; die Tabelle führt dieselbe Nr. + die Fundstelle (markierter Ausschnitt).
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { ReportMarking, ReportToken, ReportModel } from './report-types';

// Typen + Disclaimer leben DB-frei in report-types (die Renderer hängen nur daran);
// hier re-exportiert, damit die bestehende Import-Fläche stabil bleibt.
export { DISCLAIMER } from './report-types';
export type { ReportMarking, ReportToken, ReportModel } from './report-types';

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
const FALLBACK_COLOR = '#6b7280';

interface PositionedMarking {
  nr: number;
  start: number;
  end: number;
  color: string;
  streitig: boolean;
}

/**
 * Text + positionierte Markierungen → Token-Strom. Zwischen den Grenzen das
 * Textstück (Farbe = kleinste überdeckende Markierung); am Ende jeder Markierung
 * deren Marker „[nr]". Mehrere an derselben Stelle endende Markierungen: alle.
 */
function buildTokens(text: string, marks: PositionedMarking[]): ReportToken[] {
  if (marks.length === 0) return [{ kind: 'text', text, color: null, streitig: false }];

  const clamp = (n: number) => Math.max(0, Math.min(text.length, n));
  const endsAt = new Map<number, PositionedMarking[]>();
  const bounds = new Set<number>([0, text.length]);
  for (const m of marks) {
    bounds.add(clamp(m.start));
    const e = clamp(m.end);
    bounds.add(e);
    (endsAt.get(e) ?? endsAt.set(e, []).get(e)!).push(m);
  }
  const points = [...bounds].sort((a, b) => a - b);

  const tokens: ReportToken[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b > a) {
      let top: PositionedMarking | null = null;
      for (const m of marks) {
        if (clamp(m.start) <= a && clamp(m.end) >= b) {
          if (!top || m.end - m.start < top.end - top.start) top = m;
        }
      }
      tokens.push({ kind: 'text', text: text.slice(a, b), color: top ? top.color : null, streitig: top?.streitig ?? false });
    }
    // Marker für alle Markierungen, die an Punkt b enden.
    const ending = endsAt.get(b);
    if (ending) {
      for (const m of [...ending].sort((x, y) => x.nr - y.nr)) {
        tokens.push({ kind: 'marker', nr: m.nr, color: m.color });
      }
    }
  }
  return tokens;
}

export async function buildReportModel(
  ctx: TenantContext,
  analysisId: string,
  opts?: { markingIds?: string[] },
): Promise<ReportModel | null> {
  return withTenantContext(ctx, async (tx) => {
    const a = await tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        markings: true,
        client: { select: { name: true } },
      },
    });
    if (!a) return null;

    // Optionale Auswahl: nur diese Markierungen exportieren. Die Nr. wird INNERHALB
    // der Auswahl neu vergeben (saubere Zuordnung Text ↔ Tabelle); nicht gewählte
    // Stellen erscheinen im Sachverhalt als normaler Text. Unbekannte IDs werden
    // ignoriert (Schnittmenge); leere/fehlende Auswahl → alle.
    const sel = opts?.markingIds && opts.markingIds.length > 0 ? new Set(opts.markingIds) : null;
    const chosen = sel ? a.markings.filter((m) => sel.has(m.id)) : a.markings;

    // Deterministische Reihenfolge (Position) → laufende Nr. für Text + Tabelle.
    const ordered = [...chosen].sort((m1, m2) => m1.start - m2.start || m1.end - m2.end || m1.id.localeCompare(m2.id));

    const markings: ReportMarking[] = ordered.map((m, i) => ({
      nr: i + 1,
      fundstelle: m.matchedText,
      begriff: m.begriff,
      herkunftLabel: HERKUNFT_LABEL[m.herkunft] ?? m.herkunft,
      herkunftColor: HERKUNFT_COLOR[m.herkunft] ?? FALLBACK_COLOR,
      engineStatusLabel: m.engineStatus ? (ENGINE_STATUS_LABEL[m.engineStatus] ?? m.engineStatus) : null,
      streitig: m.streitig,
      normAnker: m.normAnker,
      governanceLabel: m.governanceTyp ? (GOV_LABEL[m.governanceTyp] ?? m.governanceTyp) : null,
      schadenLabel: m.schadensintensitaet ? (STUFE_LABEL[m.schadensintensitaet] ?? m.schadensintensitaet) : null,
      wahrscheinlichkeitLabel: m.wahrscheinlichkeit ? (WK_LABEL[m.wahrscheinlichkeit] ?? m.wahrscheinlichkeit) : null,
      statusLabel: STATUS_LABEL[m.status] ?? m.status,
      kontrolle: m.kontrolle,
      notiz: m.notiz,
    }));

    const tokens = buildTokens(
      a.sourceText,
      ordered.map((m, i) => ({
        nr: i + 1,
        start: m.start,
        end: m.end,
        color: m.streitig ? STREIT_COLOR : (HERKUNFT_COLOR[m.herkunft] ?? FALLBACK_COLOR),
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
      tokens,
      markings,
      counts: {
        // Anzahl der EXPORTIERTEN Markierungen (Auswahl), nicht der gesamten Analyse.
        gesamt: chosen.length,
        eigen: chosen.filter((m) => m.herkunft === 'BERATER').length,
      },
    };
  });
}
