// =============================================================================
// @taxtronik/risk-layer — Public API.
//
// Typisierter Transport-Client um die §4-TCMS-Engine + Domänen-Mapping.
// Keine Geschäftslogik, kein DB-Zugriff. Die App-seitige Persistenz/Delegation
// liegt in apps/web/src/server/risk.
// =============================================================================

export { RiskLayerClient } from './client';
export type { RiskLayerClientOptions, ZweiphasenAnalyseInput } from './client';
export { RiskLayerHttpError } from './client';

export {
  isRiskLayerConfigured,
  requireRiskLayerConfig,
  RiskLayerNotConfiguredError,
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
  Karte,
  Risiko,
  HealthResponse,
  KatalogResponse,
  KatalogDefiniereResponse,
  KatalogKuratiereResponse,
  LlmStatusResponse,
  LlmStartResponse,
  OpaqueObject,
} from './schema';

export { CircuitBreaker, CircuitOpenError, executeResilient, withRetry } from './resilience';
export type {
  CircuitState,
  CircuitBreakerOptions,
  RetryOptions,
} from './resilience';
