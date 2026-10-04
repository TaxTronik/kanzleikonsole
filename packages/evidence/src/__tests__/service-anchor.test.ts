import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ANCHOR_LEASE_EXPIRED_REASON,
  ANCHOR_LEASE_LOST_REASON,
  EvidenceService,
  TsaAnchorError,
} from '../service';
import { ANCHOR_LEASE_TTL_MS } from '../anchor-lease';
import { anchorGenesisHash } from '../anchor';
import { immediateAnchorLikePatterns, isImmediateAnchorAction } from '../anchor-schedule';
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

// Fachkatalog: AUDIT-RFC3161-ANCHOR-001 — P-05: Tenant-Lease um den TSA-Aufruf.
describe('anchorLatest mit Tenant-Lease', () => {
  const holder = '00000000-0000-4000-8000-00000000a11e';

  it('bestätigt den Lease unmittelbar vor der TSA-Anfrage und bindet das Insert daran', async () => {
    const port = new AnchorTsa();
    const { tx, executeRaw } = txFor();
    const confirm = vi.fn(async () => {
      // Vor der Anfrage und erneut nach der Antwort, beides vor dem Insert.
      expect(port.timestamp).toHaveBeenCalledTimes(confirm.mock.calls.length - 1);
      expect(executeRaw).not.toHaveBeenCalled();
      return true;
    });

    const result = await new EvidenceService(port).anchorLatest(tx, tenantId, {
      lease: { holder, confirm },
    });

    expect(result).toMatchObject({ anchored: true, topAuditId: 12n });
    expect(confirm).toHaveBeenCalledTimes(2);
    const insertSql = (executeRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(insertSql).toContain('FROM audit_anchor_lease');
    expect(executeRaw.mock.calls[0]).toContain(holder);
  });

  it('fragt ohne gültigen Lease weder TSA an noch fügt ein', async () => {
    const port = new AnchorTsa();
    const { tx, executeRaw } = txFor();

    const result = await new EvidenceService(port).anchorLatest(tx, tenantId, {
      lease: { holder, confirm: async () => false },
    });

    expect(result).toEqual({ anchored: false, reason: ANCHOR_LEASE_LOST_REASON });
    expect(port.timestamp).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('verwirft das Token, wenn der Lease während der TSA-Anfrage abläuft', async () => {
    const port = new AnchorTsa();
    const { tx, executeRaw } = txFor();
    const confirm = vi.fn(async () => confirm.mock.calls.length === 1);

    const result = await new EvidenceService(port).anchorLatest(tx, tenantId, {
      lease: { holder, confirm },
    });

    expect(result).toEqual({ anchored: false, reason: ANCHOR_LEASE_EXPIRED_REASON });
    expect(port.timestamp).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('begrenzt die Sperre durch einen abgestürzten Halter auf 30 s über dem TSA-Timeout', () => {
    expect(ANCHOR_LEASE_TTL_MS).toBe(30_000);
    expect(ANCHOR_LEASE_TTL_MS).toBeGreaterThan(10_000);
  });

  it('meldet TSA-Fehler als TsaAnchorError, Datenbankfehler unverändert', async () => {
    const port = new AnchorTsa();
    port.timestamp.mockRejectedValueOnce(new Error('TSA HTTP 503'));
    await expect(new EvidenceService(port).anchorLatest(txFor().tx, tenantId)).rejects.toThrow(
      TsaAnchorError,
    );

    const untrusted = new AnchorTsa();
    untrusted.verifyDetailed.mockResolvedValueOnce({ ok: true, trustAnchored: false });
    await expect(
      new EvidenceService(untrusted).anchorLatest(txFor().tx, tenantId, {
        requireTrustAnchor: true,
      }),
    ).rejects.toBeInstanceOf(TsaAnchorError);

    const poolError = new Error('Unable to start a transaction in the given time.');
    const { tx, executeRaw } = txFor();
    executeRaw.mockRejectedValueOnce(poolError);
    await expect(new EvidenceService(new AnchorTsa()).anchorLatest(tx, tenantId)).rejects.toBe(
      poolError,
    );
  });
});

// Fachkatalog: AUDIT-RFC3161-ANCHOR-001 — Klassen ohne Mindestabstand (eine Definition).
describe('Sofort zu verankernde Aktionen', () => {
  it.each([
    'invoice.send',
    'gwg.check.verify',
    'client.update.gwg_relevant',
    'client.deactivate.gwg_expired',
    'stbvv.invoice.draft',
  ])('verankert %s ohne Mindestabstand', (action) => {
    expect(isImmediateAnchorAction(action)).toBe(true);
  });

  it.each(['client.update', 'client.update.gwgXrelevant', 'stbvv.quote.create', 'invoices'])(
    'wartet bei %s den Mindestabstand ab',
    (action) => {
      expect(isImmediateAnchorAction(action)).toBe(false);
    },
  );

  it('bildet für jedes Präfix ein LIKE-Muster', () => {
    expect(immediateAnchorLikePatterns()).toEqual(['invoice.%', 'gwg.%', 'stbvv.invoice.%']);
  });
});
