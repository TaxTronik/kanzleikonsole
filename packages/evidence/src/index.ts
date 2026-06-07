// =============================================================================
// @taxtronik/evidence — Public API
// =============================================================================

export { EvidenceService, type AuditEventInput, type RecordedEvent } from './service';
export { canonicalJson } from './canonical-json';
export { eventHash, chainValue, type ChainEvent } from './chain';
export {
  serializeArchive,
  parseArchive,
  verifyArchiveChain,
  type ArchiveAuditRow,
  type ArchiveSerializeResult,
  type ParsedArchiveRow,
  type ChainCheckResult,
} from './archive';
export {
  type TimestampPort,
  type TimestampResult,
  LocalTimestampAdapter,
  Rfc3161StubAdapter,
} from './ports/timestamp';
export { Rfc3161HttpAdapter } from './ports/rfc3161-http';
export {
  TSA_PROVIDERS,
  getTsaProvider,
  resolveTsaUrl,
  type TsaProvider,
} from './providers/tsa-providers';
