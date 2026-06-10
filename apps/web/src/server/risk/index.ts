// =============================================================================
// Risk-Layer / TCMS — app-seitige Geschäftslogik (Persistenz + Delegation).
//
// Der reine Transport liegt im Paket @taxtronik/risk-layer; hier ist die
// tenant-scoped Persistenz, die Delegation an die Wiedervorlage und der
// Katalog-Rückfluss.
// =============================================================================

export { saveAnalysis } from './persistence';
export type { SaveAnalysisInput, SaveAnalysisResult } from './persistence';

export { runDeterministicAnalysis, runLlmAnalysis } from './run-analysis';
export type { RunAnalysisInput, RunAnalysisOutput, AnalyseCapableClient } from './run-analysis';

export { delegateMarking } from './delegate';
export type { DelegateMarkingInput, DelegateMarkingResult } from './delegate';
export { buildDelegationNotes } from './delegate-notes';
export type { DelegationMarkingContext } from './delegate-notes';

export { pushDefinitionToCatalog } from './catalog-feedback';
export type {
  PushDefinitionInput,
  PushDefinitionResult,
  DefineCapableClient,
} from './catalog-feedback';

export { resolveNorm, searchNorm } from './resolve-norm';
export type { ResolvedNorm, NormResolveClient, NormHit, NormSearchClient } from './resolve-norm';

export {
  addBeraterNorm, setNormVerworfen, removeBeraterNorm,
  readNormRefs, effectiveAnker, applyAddBerater, applyVerworfen, applyRemoveBerater,
  NormListChangedError, InvalidNormError,
} from './norms';
export type { CuratedNormRef, NormQuelle, NormTarget } from './norms';

export { kuratiereKatalogNorm, readKatalogKuratierung, NotACatalogMarkingError, CatalogCurationFailedError } from './catalog-norms';
export type {
  KuratiereKatalogNormInput, NormKuratierAktion, NormKuratierScope,
  KatalogKuratierClient, KatalogReadClient, KatalogKuratierungView,
} from './catalog-norms';

export { setKatalogReviewStatus, CatalogReviewFailedError } from './catalog-review';
export type { KatalogReviewInput, KatalogReviewResult, ReviewCapableClient } from './catalog-review';

export { getLlmStatus } from './llm';
export type { LlmStatusDTO, LlmStatusClient } from './llm';

export { listPromptTemplates, createPromptTemplate, deletePromptTemplate } from './prompt-templates';
export type { PromptTemplateDTO } from './prompt-templates';

export { archiveAnalysis, AlreadyArchivedError } from './archive';

export { reformatSourceDoc } from './reformat';
export type { ReformatInput, ReformatResult } from './reformat';

export { reanalyzeAnalysis } from './reanalyze';
export type { ReanalyzeResult, ReanalyzeClient } from './reanalyze';

export { updateMarking, addManualMarking, deleteMarking } from './markings';
export type {
  UpdateMarkingInput,
  AddManualMarkingInput,
  RiskStatus,
} from './markings';

export { listAnalyses, loadAnalysis, listExtractableDocuments, loadResearchResults, loadResearchRequests } from './queries';

export { extractText, UnsupportedDocumentTypeError } from './extract-text';

export { anonymize, deanonymize } from './anonymize';
export type { AnonymizeClient, AnonymizeContact, AnonymizeResult } from './anonymize';

export {
  previewResearch, sendResearchToN8n, receiveResearchResult,
  suggestMarkingsForResult, assignResultToMarking,
} from './research';
export type { ResearchInput, ResearchPreview, InboundResult } from './research';

export { scoreMarkingSuggestions, extractNormRefs } from './suggest';
export type { MarkingSuggestion, ScoreableMarking } from './suggest';
