// Fachkatalog: AUDIT-HASH-CHAIN-001
import { describe, expect, it, vi } from 'vitest';
import { eventHash } from '../chain';
import { EvidenceService, type AuditEventInput } from '../service';
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

  it('speichert -0 als 0 und hasht genau den Wert, den die Prüfung zurückliest', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ this_hash: null }])
      .mockResolvedValueOnce([{ id: 43n, occurred_at: new Date('2026-10-04T00:00:00.000Z') }]);
    const service = new EvidenceService(new LocalTimestampAdapter());
    const input: AuditEventInput = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      actorType: 'STAFF',
      actorId: '22222222-2222-4222-8222-222222222222',
      action: 'invoice.update',
      resourceType: 'invoice',
      resourceId: '33333333-3333-4333-8333-333333333333',
      before: { discount: -0 },
      after: { discount: 0, lines: [-0, 1.5] },
    };

    const result = await service.record(
      { $queryRaw: queryRaw, $queryRawUnsafe: vi.fn(), $executeRaw: vi.fn() } as never,
      input,
    );

    // INSERT-Parameter in Spaltenreihenfolge (ohne das Template-Array).
    const values = queryRaw.mock.calls[1]!.slice(1) as unknown[];
    const [occurredAt, beforeText, afterText, prevHash, thisHash] = [
      values[1] as Date,
      values[7] as string,
      values[8] as string,
      values[11] as Buffer,
      values[12] as Buffer,
    ];
    expect(beforeText).toBe('{"discount":0}');
    expect(afterText).toBe('{"discount":0,"lines":[0,1.5]}');
    expect(thisHash.equals(result.thisHash)).toBe(true);

    // Nachrechnung wie bei der Prüfung: gespeicherte Spalten, jsonb geparst.
    const verified = eventHash(prevHash, {
      tenantId: input.tenantId,
      occurredAt,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      before: JSON.parse(beforeText),
      after: JSON.parse(afterText),
    });
    expect(verified.equals(thisHash)).toBe(true);
  });
});
