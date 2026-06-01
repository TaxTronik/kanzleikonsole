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
