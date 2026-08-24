// Fachkatalog: AUDIT-HASH-CHAIN-001
import { describe, expect, it, vi } from 'vitest';
import { EvidenceService } from '../service';
import { LocalTimestampAdapter } from '../ports/timestamp';

describe('EvidenceService.record', () => {
  it('nimmt den Tenant-Lock vor dem Vorgänger-Lookup in einem eigenen Statement', async () => {
    const insertedAt = new Date('2026-07-15T12:00:00.000Z');
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ this_hash: null }])
      .mockResolvedValueOnce([{ id: 42n, occurred_at: insertedAt }]);
    const executeRaw = vi.fn();
    const service = new EvidenceService(new LocalTimestampAdapter());

    const result = await service.record(
      {
        $queryRaw: queryRaw,
        $queryRawUnsafe: vi.fn(),
        $executeRaw: executeRaw,
      } as never,
      {
        tenantId: '11111111-1111-4111-8111-111111111111',
        actorType: 'STAFF',
        actorId: '22222222-2222-4222-8222-222222222222',
        action: 'gwg.check.assess',
        resourceType: 'gwg_check',
        resourceId: '33333333-3333-4333-8333-333333333333',
      },
    );

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const lockSql = (executeRaw.mock.calls[0]![0] as TemplateStringsArray).join(' ? ');
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const previousSql = (queryRaw.mock.calls[0]![0] as TemplateStringsArray).join(' ? ');
    expect(previousSql).toContain('SELECT this_hash FROM audit_log');
    expect(result.id).toBe(42n);
    expect(result.occurredAt).toEqual(insertedAt);
    expect(result.prevHash).toHaveLength(32);
    expect(result.thisHash).toHaveLength(32);
  });
});
