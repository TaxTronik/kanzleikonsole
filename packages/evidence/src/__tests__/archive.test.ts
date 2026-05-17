// =============================================================================
// Tests für Archive-Serialisierung + Chain-Verifikation
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  serializeArchive,
  parseArchive,
  verifyArchiveChain,
  type ArchiveAuditRow,
} from '../archive';

const GENESIS_PREFIX = Buffer.from('taxtronik-genesis:', 'utf8');

function genesisHash(tenantId: string): Buffer {
  return createHash('sha256').update(GENESIS_PREFIX).update(Buffer.from(tenantId, 'utf8')).digest();
}

function makeChain(tenantId: string, n: number): ArchiveAuditRow[] {
  const out: ArchiveAuditRow[] = [];
  let prev = genesisHash(tenantId);
  for (let i = 0; i < n; i++) {
    const occurredAt = new Date(Date.UTC(2025, 0, 1, 0, 0, i));
    const row: Omit<ArchiveAuditRow, 'thisHash'> = {
      id: i + 1,
      tenantId,
      occurredAt,
      actorType: 'STAFF',
      actorId: 'staff-1',
      action: `event.${i}`,
      resourceType: 'thing',
      resourceId: `r${i}`,
      before: null,
      after: { i },
      ip: null,
      userAgent: null,
      prevHash: prev,
    };
    const canonical = Buffer.from(
      JSON.stringify({
        action: row.action,
        actorId: row.actorId,
        actorType: row.actorType,
        after: row.after,
        before: null,
        occurredAt: row.occurredAt.toISOString(),
        resourceId: row.resourceId,
        resourceType: row.resourceType,
        tenantId: row.tenantId,
      }),
      'utf8',
    );
    const thisHash = createHash('sha256').update(prev).update(canonical).digest();
    out.push({ ...row, thisHash });
    prev = thisHash;
  }
  return out;
}

describe('serializeArchive', () => {
  it('Liefert deterministisches NDJSON mit Anker-Werten', () => {
    const rows = makeChain('tenant-1', 3);
    const r = serializeArchive(rows);
    expect(r.entryCount).toBe(3);
    expect(r.fromAuditId).toBe(BigInt(1));
    expect(r.toAuditId).toBe(BigInt(3));
    expect(r.firstPrevHash.equals(rows[0]!.prevHash)).toBe(true);
    expect(r.lastThisHash.equals(rows[2]!.thisHash)).toBe(true);
    // NDJSON: 3 Zeilen + abschließendes \n
    const lines = r.ndjson.toString('utf8').split('\n');
    expect(lines.length).toBe(4);
    expect(lines[3]).toBe('');
  });

  it('Zwei Aufrufe erzeugen byte-identisches NDJSON', () => {
    const rows = makeChain('tenant-1', 5);
    const a = serializeArchive(rows);
    const b = serializeArchive(rows);
    expect(a.ndjson.equals(b.ndjson)).toBe(true);
    expect(a.fileSha256.equals(b.fileSha256)).toBe(true);
  });

  it('Wirft bei leerer Eingabe', () => {
    expect(() => serializeArchive([])).toThrow();
  });
});

describe('parseArchive + verifyArchiveChain', () => {
  it('Round-Trip: serialize → parse → verify ok', () => {
    const rows = makeChain('tenant-2', 5);
    const ser = serializeArchive(rows);
    const parsed = parseArchive(ser.ndjson);
    expect(parsed.length).toBe(5);
    expect(parsed[0]!.action).toBe('event.0');
    expect(parsed[4]!.action).toBe('event.4');
    const check = verifyArchiveChain(parsed, {
      firstPrevHash: ser.firstPrevHash,
      lastThisHash: ser.lastThisHash,
    });
    expect(check.ok).toBe(true);
  });

  it('Erkennt Manipulation einer Zwischenzeile direkt (re-hash, U-4)', () => {
    const rows = makeChain('tenant-3', 4);
    const ser = serializeArchive(rows);
    const parsed = parseArchive(ser.ndjson);
    // Manipuliere thisHash der Zeile 2. U-4: Re-Hash erkennt das jetzt direkt
    // an der manipulierten Zeile (computed != stored), nicht erst an der
    // Folgezeile über die prev_hash-Linkage. brokenAtId = manipulierte Zeile.
    parsed[1] = { ...parsed[1]!, thisHash: Buffer.alloc(32, 0xff) };
    const check = verifyArchiveChain(parsed, {
      firstPrevHash: ser.firstPrevHash,
      lastThisHash: ser.lastThisHash,
    });
    expect(check.ok).toBe(false);
    expect(check.brokenAtId).toBe(parsed[1]!.id);
  });

  it('Erkennt Manipulation des Event-Body in-place (U-4: re-hash)', () => {
    const rows = makeChain('tenant-3b', 3);
    const ser = serializeArchive(rows);
    const parsed = parseArchive(ser.ndjson);
    // In-place-Manipulation des `action`-Feldes ohne prev_hash/this_hash
    // anzufassen. Alte (linkage-only) Verifikation hätte das nicht erkannt.
    parsed[1] = { ...parsed[1]!, action: 'event.HACKED' };
    const check = verifyArchiveChain(parsed, {
      firstPrevHash: ser.firstPrevHash,
      lastThisHash: ser.lastThisHash,
    });
    expect(check.ok).toBe(false);
    expect(check.brokenAtId).toBe(parsed[1]!.id);
  });

  it('Erkennt falsche firstPrevHash', () => {
    const rows = makeChain('tenant-4', 3);
    const ser = serializeArchive(rows);
    const parsed = parseArchive(ser.ndjson);
    const check = verifyArchiveChain(parsed, {
      firstPrevHash: Buffer.alloc(32, 0xab),
      lastThisHash: ser.lastThisHash,
    });
    expect(check.ok).toBe(false);
    expect(check.brokenAtId).toBe(parsed[0]!.id);
  });

  it('Erkennt falsche lastThisHash', () => {
    const rows = makeChain('tenant-5', 3);
    const ser = serializeArchive(rows);
    const parsed = parseArchive(ser.ndjson);
    const check = verifyArchiveChain(parsed, {
      firstPrevHash: ser.firstPrevHash,
      lastThisHash: Buffer.alloc(32, 0xcd),
    });
    expect(check.ok).toBe(false);
  });
});
