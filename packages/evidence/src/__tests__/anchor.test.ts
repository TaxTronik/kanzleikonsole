import { describe, expect, it } from 'vitest';
import { anchorGenesisHash, anchorPayload, anchorTokenHash } from '../anchor';

describe('rolling anchor contract', () => {
  it('ist deterministisch und bindet Tenant, lokalen Top und externen Vorgänger', () => {
    const input = {
      tenantId: 'tenant-a',
      fromAuditId: 1n,
      topAuditId: 4n,
      topHash: Buffer.alloc(32, 1),
      previousAnchorHash: anchorGenesisHash('tenant-a'),
    };

    expect(anchorPayload(input)).toEqual(anchorPayload(input));
    expect(anchorPayload({ ...input, previousAnchorHash: Buffer.alloc(32, 9) })).not.toEqual(
      anchorPayload(input),
    );
    expect(anchorPayload({ ...input, topAuditId: 5n })).not.toEqual(anchorPayload(input));
  });

  it('trägt den Hash des vollständigen TSA-Tokens in den Folgeanker', () => {
    expect(anchorTokenHash(Buffer.from('tsa-token'))).toHaveLength(32);
    expect(anchorTokenHash(Buffer.from('tsa-token'))).not.toEqual(
      anchorTokenHash(Buffer.from('anderes-token')),
    );
  });
});
