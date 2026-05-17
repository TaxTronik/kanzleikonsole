export {
  s3,
  getBucketForClassification,
  isGobdClassification,
  isGwgClassification,
  classificationToTier,
  getBucketForTier,
  type ProtectionTier,
} from './client';
export {
  fetchObjectBytes,
  commitDocument,
  commitDocumentFromBytes,
  commitBytesWithTier,
  sanitizeFilenameForHeader,
  detectMimeFromMagicBytes,
  gobdRetentionUntil,
  gwgRetentionUntil,
  MAX_UPLOAD_BYTES,
  type CommitDocumentInput,
  type CommitDocumentResult,
  type ScanResult,
} from './service';
