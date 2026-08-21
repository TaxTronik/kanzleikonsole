import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceService } from '../service';
import { anchorGenesisHash } from '../anchor';
import {
  LocalTimestampAdapter,
  type TimestampPort,
  type TimestampResult,
} from '../ports/timestamp';

const tenantId = '00000000-0000-4000-8000-000000000001';

class AnchorTsa implements TimestampPort {
  readonly mode = 'rfc3161' as const;
  readonly timestamp = vi.fn(
    async (payload: Uint8Array): Promise<TimestampResult> => ({
      timestampedAt: '2026-08-21T10:00:01.000Z',
      tsaRequestBlob: Buffer.from('request'),
      tsaResponseBlob: createHash('sha256').update(payload).digest(),
      tsaSerial: '42',
    }),
  );
  readonly verify = vi.fn(async () => true);
  readonly verifyDetailed = vi.fn(async () => ({ ok: true, trustAnchored: true }));
}

function txFor(inserted = 1) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        from_audit_id: 10n,
        top_audit_id: 12n,
        top_hash: Buffer.alloc(32, 7),
      },
    ]);
  const executeRaw = vi.fn().mockResolvedValue(inserted);
  return {
    tx: {
      $queryRaw: queryRaw,
      $queryRawUnsafe: vi.fn(),
      $executeRaw: executeRaw,
    } as unknown as Parameters<EvidenceService['anchorLatest']>[0],
    queryRaw,
    executeRaw,
  };
}

describe('anchorLatest', () => {
  it('stempelt einen bereits committen lokalen Präfix ohne Audit-Lock', async () => {
    const port = new AnchorTsa();
    const { tx, executeRaw } = txFor();

    const result = await new EvidenceService(port).anchorLatest(tx, tenantId, {
      requireTrustAnchor: true,
    });

    expect(result).toMatchObject({
      anchored: true,
      fromAuditId: 10n,
      topAuditId: 12n,
      trustAnchored: true,
    });
    expect(port.timestamp).toHaveBeenCalledTimes(1);
    expect(port.verifyDetailed).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(String(port.timestamp.mock.calls[0]![0])).toContain(
      anchorGenesisHash(tenantId).toString('hex'),
    );
  });

  it('verwirft einen Parallel-Loser, statt einen Anchor-Zweig anzulegen', async () => {
    const port = new AnchorTsa();
    const { tx } = txFor(0);

    const result = await new EvidenceService(port).anchorLatest(tx, tenantId);

    expect(result.anchored).toBe(false);
    if (result.anchored) throw new Error('Parallel-Loser darf nicht verankert sein');
    expect(result.reason).toMatch(/paralleler Anchor-Lauf/);
  });

  it('führt mit lokalem Self-Timestamp weder Query noch Stempel aus', async () => {
    const { tx, queryRaw, executeRaw } = txFor();

    const result = await new EvidenceService(new LocalTimestampAdapter()).anchorLatest(
      tx,
      tenantId,
    );

    expect(result.anchored).toBe(false);
    if (result.anchored) throw new Error('Self-Timestamp darf keinen externen Anchor erzeugen');
    expect(result.reason).toMatch(/keine externe/);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
