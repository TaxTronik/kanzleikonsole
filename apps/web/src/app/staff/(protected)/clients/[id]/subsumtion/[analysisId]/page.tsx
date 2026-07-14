import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { guardSubsumtionPage } from '../_guard';
import {
  loadAnalysis,
  loadResearchResults,
  loadResearchRequests,
  scoreMarkingSuggestions,
} from '@/server/risk';
import { loadClientWorkflows } from '@/server/workflows/queries';
import { SubsumtionWorkspace } from '../subsumtion-workspace';
import { EditableAnalysisTitle } from '../editable-title';
import { WorkflowSection } from '../../workflows/workflow-section';
import { StartWorkflowForm } from '../../workflows/start-form';
import { withTenantContext } from '@taxtronik/db';
import { loadAnalysisDocuments } from '@/server/documents/managed-docs';
import { DocumentExplorer } from '@/components/document-explorer';
import type {
  AnalysisDTO,
  MarkingDTO,
  NormRefDTO,
  ResearchResultDTO,
  ResearchRequestDTO,
} from '../_ui';

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string; analysisId: string }>;
}) {
  const { id, analysisId } = await params;
  const { ctx, staffOptions, engineConfigured } = await guardSubsumtionPage(id);

  const analysis = await loadAnalysis(ctx, analysisId);
  if (!analysis || analysis.clientId !== id) notFound();

  // Alle weiteren Lesezugriffe sind voneinander unabhängig (brauchen nur
  // analysisId/clientId) → EIN paralleler Batch statt fünf sequenzieller
  // Round-Trips. Das In-Memory-Scoring der Recherche-Vorschläge nutzt danach die
  // schon mit `analysis` geladenen Markierungen (kein N+1).
  const [rawResults, rawRequests, wf, aktenregalDocs, clientInfo] = await Promise.all([
    loadResearchResults(ctx, analysisId),
    loadResearchRequests(ctx, analysisId),
    loadClientWorkflows(ctx, { clientId: id, analysisId }),
    loadAnalysisDocuments(ctx, analysisId),
    withTenantContext(ctx, (tx) =>
      tx.client.findUnique({ where: { id }, select: { allowActive: true, name: true } }),
    ),
  ]);

  // Rechercheergebnisse + (für NEU) heuristische Zuordnungs-Vorschläge.
  const openMarkings = analysis.markings
    .filter((m) => m.status === 'OFFEN' || m.status === 'IN_PRUEFUNG')
    .map((m) => ({ id: m.id, begriff: m.begriff, normAnker: m.normAnker, status: m.status }));
  const researchResults: ResearchResultDTO[] = rawResults.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    markingId: r.markingId,
    source: r.source,
    receivedAt: r.receivedAt.toISOString(),
    suggestions: r.status === 'NEU' ? scoreMarkingSuggestions(r, openMarkings) : [],
  }));

  // Outbound: gesendete Rechercheaufträge (für den Recherche-Hub).
  const researchRequests: ResearchRequestDTO[] = rawRequests.map((r) => ({
    id: r.id,
    markingId: r.markingId,
    begriff: r.marking?.begriff ?? null,
    prompt: r.prompt,
    includeSachverhalt: r.includeSachverhalt,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    createdById: r.createdById,
    resultCount: r._count.results,
  }));

  // Aufgaben-Tab: Workflows dieses Sachverhalts — exakt die WorkflowSection des
  // Builders (kein Doppel-Code), gescopt per analysisId. Als fertiger Server-Slot.
  const aufgaben = (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted max-w-xl">
          Workflows zu diesem Sachverhalt — bauen + ausführen wie im Workflow-Builder, aber nur für
          diese Analyse.
        </p>
        <StartWorkflowForm
          clientId={id}
          templates={wf.templates}
          staffOptions={wf.staffList}
          analysisId={analysisId}
        />
      </div>
      <WorkflowSection
        clientId={id}
        instances={wf.instances}
        staffList={wf.staffList}
        formTemplates={wf.formTemplates}
        requestTemplates={wf.requestTemplates}
        emailTemplates={wf.emailTemplates}
        emptyHint="Noch kein Workflow zu diesem Sachverhalt — oben einen starten (Vorlage oder eigener Workflow)."
      />
    </div>
  );

  // Aktenregal-Tab: Dokumente dieses Sachverhalts — reuse DocumentExplorer,
  // gescopt per analysisId (Uploads setzen analysis_id; GwG-Gate wie am Mandanten).
  const aktenregal = (
    <DocumentExplorer
      variant="embedded"
      clientId={id}
      analysisId={analysisId}
      canUpload={clientInfo?.allowActive ?? false}
      scopeLabel={analysis.title ?? clientInfo?.name ?? 'Sachverhalt'}
      folders={[]}
      documents={aktenregalDocs}
    />
  );

  const dto: AnalysisDTO = {
    id: analysis.id,
    sourceText: analysis.sourceText,
    title: analysis.title,
    textHash: analysis.textHash,
    sourceDoc: analysis.sourceDoc ?? null,
    llmEnrichedAt: analysis.llmEnrichedAt ? analysis.llmEnrichedAt.toISOString() : null,
    archivedAt: analysis.archivedAt ? analysis.archivedAt.toISOString() : null,
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
        <Link
          href={`/staff/clients/${id}/subsumtion`}
          className="text-disabled hover:text-secondary shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <EditableAnalysisTitle
          clientId={id}
          analysisId={analysisId}
          initialTitle={analysis.title}
        />
      </div>
      <SubsumtionWorkspace
        clientId={id}
        staffOptions={staffOptions}
        clientDocuments={[]}
        researchResults={researchResults}
        researchRequests={researchRequests}
        aufgaben={aufgaben}
        aktenregal={aktenregal}
        engineConfigured={engineConfigured}
        initial={dto}
      />
    </div>
  );
}
