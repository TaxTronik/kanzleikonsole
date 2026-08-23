import { describe, expect, it, vi } from 'vitest';
import { EvidenceService } from '../service';
import type { TimestampPort, TimestampResult } from '../ports/timestamp';

const tenantId = '00000000-0000-4000-8000-000000000001';

class UntrustedTsa implements TimestampPort {
  readonly mode = 'rfc3161' as const;
  readonly timestamp = vi.fn(
    async (): Promise<TimestampResult> => ({
      timestampedAt: '2026-08-22T12:00:00.000Z',
      tsaRequestBlob: Buffer.from('request'),
      tsaResponseBlob: Buffer.from('untrusted-response'),
      tsaSerial: '1',
    }),
  );
  readonly verify = vi.fn(async () => false);
}

describe('sealDay trust policy', () => {
  it('does not persist a timestamp response that fails trust verification', async () => {
    const port = new UntrustedTsa();
    const executeRaw = vi.fn();
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 7n, this_hash: Buffer.alloc(32, 7) }]);
    const tx = {
      $queryRaw: queryRaw,
      $queryRawUnsafe: vi.fn(),
      $executeRaw: executeRaw,
    } as unknown as Parameters<EvidenceService['sealDay']>[0];

    await expect(
      new EvidenceService(port).sealDay(tx, tenantId, new Date('2026-08-21T00:00:00.000Z')),
    ).rejects.toThrow(/nicht vertrauenswürdig verifiziert/);
    expect(port.verify).toHaveBeenCalledOnce();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
