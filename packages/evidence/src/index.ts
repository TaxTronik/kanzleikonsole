// =============================================================================
// @taxtronik/evidence — Public API
// =============================================================================

export {
  EvidenceService,
  ANCHOR_LEASE_LOST_REASON,
  ANCHOR_LEASE_EXPIRED_REASON,
  ANCHOR_LOCKED_REASON,
  DEFAULT_SEGMENT_LIMITS,
  TsaAnchorError,
  genesisCursor,
  type AuditEventInput,
  type RecordedEvent,
  type AnchorLatestOptions,
  type AnchorLatestResult,
  type VerificationResult,
  type IncrementalVerificationInfo,
  type ChainCursor,
  type SegmentBounds,
  type SegmentLimits,
  type SegmentOutcome,
} from './service';
export {
  IMMEDIATE_ANCHOR_ACTIONS,
  isImmediateAnchorAction,
  tenantsDueForAnchoring,
  type AnchorScheduleOptions,
} from './anchor-schedule';
export {
  ANCHOR_LEASE_TTL_MS,
  anchorLatestWithLease,
  claimAnchorLease,
  type AnchorAttempt,
  type AnchorLease,
  type SettledAnchorAttempt,
} from './anchor-lease';
export {
  verifyChainWithCheckpoints,
  checkpointIntegrityProblem,
  loadVerifyCheckpoint,
  progressAnchorMac,
  type CheckpointFindings,
  type CheckpointedVerifyOptions,
  type LoadedVerifyCheckpoint,
  type StoredVerifyCheckpoint,
  type VerifyCheckpointKind,
  type VerifyTxRunner,
} from './verify-checkpoint';
export {
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  AUDIT_ANCHOR_STATUS_SETTING_KEY,
  BACKUP_DRILL_RESULT_SETTING_KEY,
  toPersistedVerifyResult,
  type PersistedIncrementalInfo,
  type PersistedProgressAnchor,
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
  verifyArchiveTimestamp,
  archiveTimestampMeetsPolicy,
  type ArchiveAuditRow,
  type ArchiveSerializeResult,
  type ParsedArchiveRow,
  type ChainCheckResult,
  type ArchiveTimestampVerification,
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
