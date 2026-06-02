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

export { resolveNorm } from './resolve-norm';
export type { ResolvedNorm, NormResolveClient } from './resolve-norm';

export { getLlmStatus } from './llm';
export type { LlmStatusDTO, LlmStatusClient } from './llm';

export { archiveAnalysis, AlreadyArchivedError } from './archive';

export { reformatSourceDoc } from './reformat';
export type { ReformatInput, ReformatResult } from './reformat';

export { updateMarking, addManualMarking, deleteMarking } from './markings';
export type {
  UpdateMarkingInput,
  AddManualMarkingInput,
  RiskStatus,
} from './markings';

export { listAnalyses, loadAnalysis, listExtractableDocuments, loadResearchResults } from './queries';

export { extractText, UnsupportedDocumentTypeError } from './extract-text';

export { anonymize, deanonymize } from './anonymize';
export type { AnonymizeClient, AnonymizeContact, AnonymizeResult } from './anonymize';

export {
  previewResearch, sendResearchToN8n, receiveResearchResult,
  suggestMarkingsForResult, assignResultToMarking,
} from './research';
export type { ResearchInput, ResearchPreview, InboundResult, MarkingSuggestion } from './research';
