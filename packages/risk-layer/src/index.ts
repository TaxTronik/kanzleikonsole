// =============================================================================
// @taxtronik/risk-layer — Public API.
//
// Typisierter Transport-Client um die §4-TCMS-Engine + Domänen-Mapping.
// Keine Geschäftslogik, kein DB-Zugriff. Die App-seitige Persistenz/Delegation
// liegt in apps/web/src/server/risk.
// =============================================================================

export { RiskLayerClient } from './client';
export type { RiskLayerClientOptions, ZweiphasenAnalyseInput, KatalogReviewStatus } from './client';
export { RiskLayerHttpError } from './client';

export {
  isRiskLayerConfigured,
  requireRiskLayerConfig,
  RiskLayerNotConfiguredError,
  RiskLayerOperatorNotConfiguredError,
} from './config';
export type { RiskLayerConfig } from './config';

export { mapAnalyse, RiskMappingError } from './mapping';
export type {
  RiskAnalysisResult,
  RiskMarkingInput,
  NormRef,
  RiskHerkunft,
  GovernanceTyp,
  RiskStufe,
  RiskWk,
} from './mapping';

export type {
  AnalyseResponse,
  EmbeddingCancelResponse,
  EmbeddingIndexStatus,
  EmbeddingJobState,
  EmbeddingJobStatus,
  EmbeddingRefreshResponse,
  EmbeddingScheduleResponse,
  EmbeddingScheduleStatus,
  EmbeddingStatusResponse,
  Karte,
  Risiko,
  HealthResponse,
  KatalogResponse,
  KatalogDefiniereResponse,
  KatalogKuratiereResponse,
  KatalogKuratierungBegriff,
  KatalogKuratierungListe,
  KatalogReviewResponse,
  LlmStatusResponse,
  LlmStartResponse,
  LosBackend,
  LosErgebnis,
  LosNachweis,
  LosPruefenResponse,
  OpaqueObject,
} from './schema';
export {
  EmbeddingCancelResponseSchema,
  EmbeddingIndexStatusSchema,
  EmbeddingJobStateSchema,
  EmbeddingJobStatusSchema,
  EmbeddingRefreshResponseSchema,
  EmbeddingScheduleResponseSchema,
  EmbeddingScheduleStatusSchema,
  EmbeddingStatusResponseSchema,
  LosBackendSchema,
  LosNachweisSchema,
  LosErgebnisSchema,
  LosPruefenResponseSchema,
} from './schema';

export { CircuitBreaker, CircuitOpenError, executeResilient, withRetry } from './resilience';
export type { CircuitState, CircuitBreakerOptions, RetryOptions } from './resilience';
