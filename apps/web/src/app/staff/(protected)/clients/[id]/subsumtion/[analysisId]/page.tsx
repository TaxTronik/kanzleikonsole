import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { guardSubsumtionPage } from '../_guard';
import { loadAnalysis, loadResearchResults, suggestMarkingsForResult } from '@/server/risk';
import { SubsumtionWorkspace } from '../subsumtion-workspace';
import type { AnalysisDTO, MarkingDTO, NormRefDTO, ResearchResultDTO } from '../_ui';

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string; analysisId: string }>;
}) {
  const { id, analysisId } = await params;
  const { ctx, staffOptions, engineConfigured } = await guardSubsumtionPage(id);

  const analysis = await loadAnalysis(ctx, analysisId);
  if (!analysis || analysis.clientId !== id) notFound();

  // Rechercheergebnisse + (für NEU) heuristische Zuordnungs-Vorschläge. Die
  // Vorschläge je NEU-Ergebnis parallel laden (sonst N serielle Queries).
  const rawResults = await loadResearchResults(ctx, analysisId);
  const researchResults: ResearchResultDTO[] = await Promise.all(
    rawResults.map(async (r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      status: r.status,
      markingId: r.markingId,
      source: r.source,
      receivedAt: r.receivedAt.toISOString(),
      suggestions: r.status === 'NEU' ? await suggestMarkingsForResult(ctx, r.id) : [],
    })),
  );

  const dto: AnalysisDTO = {
    id: analysis.id,
    sourceText: analysis.sourceText,
    title: analysis.title,
    textHash: analysis.textHash,
    llmEnrichedAt: analysis.llmEnrichedAt ? analysis.llmEnrichedAt.toISOString() : null,
    markings: analysis.markings.map(
      (m): MarkingDTO => ({
        id: m.id,
        start: m.start,
        end: m.end,
        matchedText: m.matchedText,
        herkunft: m.herkunft,
        engineStatus: m.engineStatus,
        streitig: m.streitig,
        begriffId: m.begriffId,
        begriff: m.begriff,
        normAnker: m.normAnker,
        normRefs: Array.isArray(m.normRefs) ? (m.normRefs as unknown as NormRefDTO[]) : null,
        normketten: m.normketten ?? null,
        governanceTyp: m.governanceTyp,
        schadensintensitaet: m.schadensintensitaet,
        wahrscheinlichkeit: m.wahrscheinlichkeit,
        kaskadenreichweite: m.kaskadenreichweite,
        kontrolle: m.kontrolle,
        status: m.status,
        notiz: m.notiz,
        verantwortlichId: m.verantwortlichId,
        farbe: m.farbe,
        label: m.label,
      }),
    ),
  };

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/staff/clients/${id}/subsumtion`} className="text-disabled hover:text-secondary">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold text-primary">{analysis.title || 'Subsumtion'}</h1>
      </div>
      <SubsumtionWorkspace
        clientId={id}
        staffOptions={staffOptions}
        clientDocuments={[]}
        researchResults={researchResults}
        engineConfigured={engineConfigured}
        initial={dto}
      />
    </div>
  );
}
