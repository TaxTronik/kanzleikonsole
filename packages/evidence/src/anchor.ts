// =============================================================================
// Rolling RFC-3161 anchor chain.
//
// The local audit chain remains the complete event log. This second, sparse
// chain binds selected local chain tips to an external TSA. Each payload also
// contains the previous anchor hash, so deleting/reordering an intermediate
// TSA token is detectable as soon as a later anchor remains.
// =============================================================================

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

const ANCHOR_GENESIS_PREFIX = Buffer.from('taxtronik-audit-anchor-genesis:', 'utf8');

export interface AnchorPayloadInput {
  tenantId: string;
  fromAuditId: bigint;
  topAuditId: bigint;
  topHash: Uint8Array;
  previousAnchorHash: Uint8Array;
}

/** Tenant-specific start of the external anchor chain. */
export function anchorGenesisHash(tenantId: string): Buffer {
  return createHash('sha256')
    .update(ANCHOR_GENESIS_PREFIX)
    .update(Buffer.from(tenantId, 'utf8'))
    .digest();
}

/**
 * Bytes submitted to the TimestampPort. The HTTP adapter hashes these bytes
 * once for the RFC-3161 MessageImprint. BigInts are strings for stable JSON.
 */
export function anchorPayload(input: AnchorPayloadInput): Buffer {
  return Buffer.from(
    canonicalJson({
      contract: 'taxtronik-audit-anchor/v1',
      tenantId: input.tenantId,
      fromAuditId: input.fromAuditId.toString(),
      topAuditId: input.topAuditId.toString(),
      topHash: Buffer.from(input.topHash).toString('hex'),
      previousAnchorHash: Buffer.from(input.previousAnchorHash).toString('hex'),
    }),
    'utf8',
  );
}

/** Hash carried forward into the next anchor payload. */
export function anchorTokenHash(tsaResponse: Uint8Array): Buffer {
  return createHash('sha256').update(tsaResponse).digest();
}
