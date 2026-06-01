// =============================================================================
// Persistenz eines Risk-Analyse-Laufs (tenant-scoped, RLS).
//
// Speichert RiskAnalysis + alle Markierungen in EINER Transaktion. `rawResult`
// hält den vollständigen Engine-Output (Audit/Replay); die TCMS-relevanten
// Felder liegen erstklassig pro Markierung. Die Engine selbst persistiert nichts
// (§4) — das ist hier die datenführende Seite.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { RiskAnalysisResult } from '@taxtronik/risk-layer';

export interface SaveAnalysisInput {
  result: RiskAnalysisResult;
  /** Der analysierte Sachverhalt im Klartext (für Wieder-Öffnen + LLM-Phase). */
  sourceText: string;
  /** Optionale Bezeichnung der Subsumtion. */
  title?: string | null;
  /** Optionaler Mandantenbezug (Pflicht erst für die Delegation). */
  clientId?: string | null;
  /** Optionaler Dokumentbezug (SeaweedFS-Dokument). */
  documentId?: string | null;
  /** StaffUser, der die Analyse ausgelöst hat. */
  createdById: string;
}

export interface SaveAnalysisResult {
  analysisId: string;
  markingCount: number;
}

export async function saveAnalysis(
  ctx: TenantContext,
  input: SaveAnalysisInput,
): Promise<SaveAnalysisResult> {
  return withTenantContext(ctx, async (tx) => {
    const analysis = await tx.riskAnalysis.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: input.clientId ?? null,
        documentId: input.documentId ?? null,
        sourceText: input.sourceText,
        title: input.title ?? null,
        textHash: input.result.textHash,
        katalogVersion: input.result.katalogVersion,
        engineVersion: input.result.engineVersion,
        createdById: input.createdById,
        // Json-Felder: `as object` wie im Rest der Codebase (vgl. settings/modules).
        rawResult: input.result.rawResult as object,
        markings: {
          create: input.result.markings.map((m) => ({
            tenantId: ctx.tenantId,
            start: m.start,
            end: m.end,
            matchedText: m.matchedText,
            herkunft: m.herkunft,
            begriffId: m.begriffId,
            begriff: m.begriff,
            normAnker: m.normAnker,
            // normketten optional: undefined → SQL NULL (kein Json-null nötig).
            normketten: m.normketten === null ? undefined : (m.normketten as object),
            governanceTyp: m.governanceTyp,
            schadensintensitaet: m.schadensintensitaet,
            wahrscheinlichkeit: m.wahrscheinlichkeit,
            kaskadenreichweite: m.kaskadenreichweite,
            engineStatus: m.engineStatus,
            streitig: m.streitig,
          })),
        },
      },
      select: { id: true, _count: { select: { markings: true } } },
    });
    return { analysisId: analysis.id, markingCount: analysis._count.markings };
  });
}
