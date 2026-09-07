// Fachkatalog: AUDIT-HASH-CHAIN-001, AUDIT-ARCHIVE-001
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical-json';
import { chainValue, eventHash, type ChainEvent } from '../chain';
import { parseArchive, serializeArchive, verifyArchiveChain } from '../archive';

const event: ChainEvent = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  occurredAt: '2026-09-07T00:00:00.000Z',
  actorType: 'STAFF',
  actorId: '22222222-2222-4222-8222-222222222222',
  action: 'synthetic.audit',
  resourceType: 'synthetic',
  resourceId: null,
  before: null,
  after: null,
};
const previous = Buffer.alloc(32, 1);
const payload = (decision: string) =>
  JSON.parse(`{"accepted":true,"__proto__":{"decision":${JSON.stringify(decision)}}}`);

describe('AUDIT-HASH-CHAIN-001: every persisted own JSON key is bound', () => {
  it.each([null, false, 42, 'text', { decision: 'original' }, ['value']])(
    'preserves an own __proto__ key with value %j',
    (value) => {
      const input = JSON.parse(JSON.stringify({ ['__proto__']: value, accepted: true }));
      expect(JSON.parse(canonicalJson(input))).toEqual(input);
      expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    },
  );

  it('retains keys in nested arrays through the same JSON roundtrip as persistence', () => {
    const value = { nested: [payload('original')] };
    const result = JSON.parse(canonicalJson(chainValue(value)));
    expect(result).toEqual(value);
    expect(Object.hasOwn(result.nested[0], '__proto__')).toBe(true);
  });

  it('changes the event hash when only a previously omitted own key changes', () => {
    expect(eventHash(previous, { ...event, after: payload('original') })).not.toEqual(
      eventHash(previous, { ...event, after: payload('modified') }),
    );
  });

  it('preserves ordinary encoding and historical numeric-key enumeration', () => {
    expect(canonicalJson({ z: new Uint8Array([1, 2]), a: null, 10: 'ten', 2: 'two' })).toBe(
      '{"2":"two","10":"ten","a":null,"z":"hex:0102"}',
    );
  });
});

describe('AUDIT-ARCHIVE-001: unusual own keys survive archive and verification', () => {
  function archiveFixture() {
    const current = { ...event, after: payload('original') };
    const row = {
      ...current,
      id: 1n,
      occurredAt: new Date(current.occurredAt),
      ip: null,
      userAgent: null,
      prevHash: previous,
      thisHash: eventHash(previous, current),
    };
    return serializeArchive([row]);
  }

  it('exports complete payloads and verifies them with the shared event hashing', () => {
    const archive = archiveFixture();
    const rows = parseArchive(archive.ndjson);
    expect(rows[0]!.after).toEqual(payload('original'));
    expect(verifyArchiveChain(rows, archive).ok).toBe(true);
  });

  it('rejects a change restricted to the unusual key without an old-encoding fallback', () => {
    const archive = archiveFixture();
    const rows = parseArchive(archive.ndjson);
    rows[0]!.after = payload('modified');
    const result = verifyArchiveChain(rows, archive);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(1n);
  });

  it('does not certify a historical hash that omitted a still-present key', () => {
    const archive = archiveFixture();
    const rows = parseArchive(archive.ndjson);
    rows[0]!.after = payload('original');
    rows[0]!.thisHash = eventHash(previous, { ...event, after: { accepted: true } });
    expect(verifyArchiveChain(rows, { ...archive, lastThisHash: rows[0]!.thisHash }).ok).toBe(
      false,
    );
  });
});
