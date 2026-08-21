// =============================================================================
// @taxtronik/evidence — Public API
// =============================================================================

export {
  EvidenceService,
  type AuditEventInput,
  type RecordedEvent,
  type AnchorLatestOptions,
  type AnchorLatestResult,
  type VerificationResult,
} from './service';
export {
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  AUDIT_ANCHOR_STATUS_SETTING_KEY,
  BACKUP_DRILL_RESULT_SETTING_KEY,
  toPersistedVerifyResult,
  type PersistedVerifyResult,
  type PersistedRecoveryCheckpoint,
  type PersistedAnchorStatus,
  type PersistedDrillResult,
} from './verify-status';
export { canonicalJson } from './canonical-json';
export { eventHash, chainValue, type ChainEvent } from './chain';
export {
  anchorGenesisHash,
  anchorPayload,
  anchorTokenHash,
  type AnchorPayloadInput,
} from './anchor';
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
export { Rfc3161HttpAdapter, createRfc3161Adapter } from './ports/rfc3161-http';
export { resolveTsaTrustedRoots } from './ports/resolve-roots';
export {
  TSA_PROVIDERS,
  getTsaProvider,
  resolveTsaUrl,
  type TsaProvider,
} from './providers/tsa-providers';
